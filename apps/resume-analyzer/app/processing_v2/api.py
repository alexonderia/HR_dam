"""Bounded HTTP access to the API of one verified job. No S3 access."""

import hashlib
import json
from urllib.parse import urlsplit

import requests

from .protocol import ClosedJob, DocumentError, InvalidJob, RetryJob


class JobAPI:
    def __init__(self, base, job, stopped=lambda: False):
        self.base, self.job, self.stopped = base, job, stopped
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers["Authorization"] = f"Bearer {job.token}"
        self.root = f"{base}/jobs/{job.id}"

    def close(self):
        self.session.close()

    def check(self):
        self.job.check_open()
        if self.stopped():
            raise RetryJob()

    def request(self, method, url, **kwargs):
        self.check()
        try:
            response = self.session.request(method, url, timeout=(3, 20), allow_redirects=False, **kwargs)
        except requests.RequestException:
            raise RetryJob() from None
        status = response.status_code
        if status in (404, 410):
            response.close()
            raise ClosedJob()
        if status == 401:
            response.close()
            self.check()
            raise InvalidJob()
        if status == 409:
            response.close()
            if url.endswith("/input"):
                raise ClosedJob()
            self.input()  # ACK only if the API confirms this job is no longer active.
            raise InvalidJob()
        if status == 429 or status >= 500:
            response.close()
            raise RetryJob()
        if status == 422 and method == "PUT" and "/output/" in url:
            response.close()
            raise DocumentError("INVALID_FILE", "Выделенный файл не прошёл проверку безопасности или формата.")
        if status != 200:
            response.close()
            raise InvalidJob()
        return response

    def json_request(self, method, path, **kwargs):
        with self.request(method, self.root + path, **kwargs) as response:
            # Internal metadata/results are bounded too; do not materialize an
            # unbounded response from a broken API in the shared worker process.
            data = bytearray()
            for chunk in response.iter_content(65536):
                self.check()
                data.extend(chunk)
                if len(data) > 32 * 1024 * 1024:
                    raise InvalidJob()
            try:
                value = json.loads(data)
            except (ValueError, TypeError):
                raise InvalidJob() from None
            if not isinstance(value, dict):
                raise InvalidJob()
            return value

    def input(self):
        value = self.json_request("GET", "/input", stream=True)
        if value.get("job_id") != self.job.id or type(value.get("attempt")) is not int or value["attempt"] != self.job.command["attempt"]:
            raise InvalidJob()
        if value.get("should_process") is False:
            raise ClosedJob()
        if value.get("should_process") is not True:
            raise InvalidJob()
        return value

    def download(self, description, limits, directory):
        file_id = self.job.command["file_id"]
        if description.get("file_id") != file_id:
            raise InvalidJob()
        # download_path is API metadata, not an arbitrary URL to follow.
        expected = f"{urlsplit(self.base).path}/jobs/{self.job.id}/files/{file_id}"
        if description.get("download_path") != expected:
            raise InvalidJob()
        size = description.get("size_bytes")
        maximum = limits.get("max_file_bytes")
        if type(maximum) is not int or not 0 < maximum <= 52428800 or type(size) is not int or not 0 < size <= maximum:
            raise InvalidJob()
        path = directory / "input"
        digest, received = hashlib.sha256(), 0
        try:
            with self.request("GET", self.root + f"/files/{file_id}", stream=True) as response, path.open("wb") as output:
                for chunk in response.iter_content(65536):
                    self.check()
                    received += len(chunk)
                    if received > size:
                        raise InvalidJob()
                    digest.update(chunk)
                    output.write(chunk)
        except requests.RequestException:
            raise RetryJob() from None
        if received != size or digest.hexdigest() != description.get("sha256"):
            raise InvalidJob()
        return path

    def progress(self):
        value = self.json_request("POST", "/progress", json={"job_id": self.job.id,
            "attempt": self.job.command["attempt"], "status": "processing"}, stream=True)
        if value.get("accepted") is not True:
            raise InvalidJob()

    def result(self, value):
        self.input()  # Fence deleted/expired/superseded jobs before sending results.
        response = self.json_request("POST", "/result", json=value, stream=True)
        if response.get("accepted") is not True:
            raise InvalidJob()

    def output(self, key, path, metadata):
        self.input()
        with path.open("rb") as source:
            value = self.json_request("PUT", f"/output/{key}", files={
                "file": (metadata["file_name"], source, metadata["mime_type"]),
                "metadata": (None, json.dumps(metadata)),
            }, stream=True)
        if value.get("size_bytes") != path.stat().st_size or value.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
            raise InvalidJob()
        if not isinstance(value.get("file_id"), str):
            raise InvalidJob()
        return value["file_id"]
