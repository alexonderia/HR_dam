"""One process, two vhost connections, one shared processing capacity."""

import json
import logging
import os
import signal
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import pika
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

from .api import JobAPI
from .protocol import ClosedJob, DocumentError, InvalidJob, RetryJob, api_address, verify_delivery


logger = logging.getLogger("processing")


def handle_delivery(body, properties, mode, operation, key, base, stopped, processor):
    api = None
    try:
        job = verify_delivery(body, properties, mode, operation, key)
        api = JobAPI(base, job, stopped)
        metadata = api.input()
        if "saved_result" in metadata:
            api.result(metadata["saved_result"])
            return "ack"
        with TemporaryDirectory(prefix=f"hr-{job.id}-") as workspace:
            directory = Path(workspace)
            source = api.download(metadata["file"], metadata["limits"], directory)
            api.progress()
            try:
                result = processor(api, metadata, source, directory)
            except DocumentError as exc:
                result = {"status": "failed", "error": {"code": exc.code, "message": exc.message}}
            api.result(result)
        return "ack"
    except ClosedJob:
        return "ack"
    except InvalidJob:
        logger.warning("Delivery rejected: invalid command, token or API contract (%s/%s)", mode, operation)
        return "reject"
    except RetryJob:
        return "retry"
    except Exception as exc:
        # Neither payloads, tokens, URLs, filenames nor model output are logged.
        logger.error("Temporary worker failure (%s/%s, %s)", mode, operation, type(exc).__name__)
        return "retry"
    finally:
        if api:
            api.close()


def consume(mode, operation, amqp_url, key, base, stop, executor, processor, connected):
    while not stop.is_set():
        connection = None
        disconnected = threading.Event()
        pending = set()
        try:
            options = pika.URLParameters(amqp_url)
            options.heartbeat = 30
            options.socket_timeout = 5
            options.stack_timeout = 10
            options.blocked_connection_timeout = 10
            connection = pika.BlockingConnection(options)
            channel = connection.channel()
            channel.basic_qos(prefetch_count=1)

            def delivered(ch, method, properties, body):
                if stop.is_set():
                    ch.basic_reject(method.delivery_tag, requeue=True)
                    return
                future = executor.submit(handle_delivery, body, properties, mode, operation, key, base,
                                         lambda: stop.is_set() or disconnected.is_set(), processor)
                pending.add(future)

                def completed(work, session=connection, current=ch, tag=method.delivery_tag):
                    if work.cancelled():
                        action = "retry"
                    else:
                        action = work.result()

                    def settle():
                        pending.discard(work)
                        if current.is_open:
                            if action == "ack":
                                current.basic_ack(tag)
                            else:
                                # basic.reject, not nack, advances RabbitMQ 4.3's
                                # delivery-count and native delayed retry.
                                current.basic_reject(tag, requeue=action == "retry")
                    try:
                        session.add_callback_threadsafe(settle)
                    except pika.exceptions.ConnectionWrongStateError:
                        pass  # Broker returns the unacknowledged delivery.

                future.add_done_callback(completed)

            channel.basic_consume(f"hr.{mode}.{operation}", delivered, auto_ack=False)
            connected[mode] = True
            while not stop.is_set() and connection.is_open:
                connection.process_data_events(time_limit=1)
        except Exception as exc:
            logger.warning("Broker connection unavailable (%s/%s, %s)", mode, operation, type(exc).__name__)
        finally:
            disconnected.set()
            connected[mode] = False
            for future in tuple(pending):
                future.cancel()
            if connection and connection.is_open:
                try:
                    connection.close()
                except pika.exceptions.AMQPError:
                    pass
        stop.wait(2)


def main():
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    # The shared legacy extractor must never retain text across vhosts/jobs.
    os.environ["TEXT_CACHE_MAX_ITEMS"] = "0"
    os.environ["TEXT_CACHE_MAX_BYTES"] = "0"
    os.environ["DIAGNOSTIC_LOGS_ENABLED"] = "false"
    operation = os.environ.get("PROCESSING_OPERATION")
    if operation not in {"prepare", "evaluate"}:
        raise ValueError("PROCESSING_OPERATION must be prepare or evaluate")
    stop = threading.Event()
    if operation == "evaluate":
        from .evaluator import evaluate as processor
        from app.readiness import monitor
        threading.Thread(target=monitor, args=(stop,), daemon=True, name="model-readiness").start()
    else:
        from .parser import prepare as processor

    connected = {"guest": False, "authorized": False}
    configurations = []
    for mode in connected:
        prefix = mode.upper()
        amqp = os.environ[f"{prefix}_AMQP_URL"]
        options = pika.URLParameters(amqp)
        if options.virtual_host != f"hr-{mode}":
            raise ValueError(f"Invalid {mode} vhost configuration")
        key = load_pem_public_key(Path(os.environ[f"{prefix}_JOB_PUBLIC_KEY_FILE"]).read_bytes())
        if not isinstance(key, RSAPublicKey) or key.key_size < 2048:
            raise ValueError(f"Invalid {mode} public key configuration")
        base = api_address(os.environ[f"{prefix}_API_BASE_URL"], mode)
        configurations.append((mode, amqp, key, base))

    class Health(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/health":
                self.send_error(404)
                return
            ok = all(connected.values()) and not stop.is_set()
            payload = json.dumps({"ok": ok, "operation": operation, "broker": connected}).encode()
            self.send_response(200 if ok else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ["PORT"])), Health)
    threading.Thread(target=server.serve_forever, daemon=True, name="health").start()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=operation)
    threads = []
    for mode, amqp, key, base in configurations:
        thread = threading.Thread(target=consume, args=(mode, operation, amqp, key, base, stop,
            executor, processor, connected), name=f"{mode}-consumer", daemon=True)
        thread.start()
        threads.append(thread)
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_args: stop.set())
    try:
        while not stop.wait(1):
            if not all(thread.is_alive() for thread in threads):
                raise RuntimeError("Consumer thread stopped")
    finally:
        stop.set()
        server.shutdown()
        for thread in threads:
            thread.join(timeout=12)
        executor.shutdown(wait=True, cancel_futures=True)
        server.server_close()


if __name__ == "__main__":
    main()
