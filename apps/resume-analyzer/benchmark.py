import json
import time
import requests

URL = "http://127.0.0.1:8000/rank"
FILE_PATH = "/tmp/benchmark_input.docx"

requirements = {
    "clusters": [
        {
            "id": "cluster-1",
            "name": "Разработка",
            "comment": "Технический тест",
            "profiles": [
                {
                    "id": "profile-1",
                    "position_name": "Python-разработчик",
                    "keywords": ["Python", "FastAPI", "SQL"],
                    "stop_factors": []
                }
            ]
        }
    ]
}

print("Health:", requests.get(
    "http://127.0.0.1:8000/health", timeout=10
).status_code)

for run in range(1, 4):
    started = time.perf_counter()

    try:
        with open(FILE_PATH, "rb") as file:
            response = requests.post(
                URL,
                files={
                    "file": (
                        "benchmark.docx",
                        file,
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    )
                },
                data={
                    "requirements": json.dumps(
                        requirements, ensure_ascii=False
                    )
                },
                timeout=900
            )

        elapsed = time.perf_counter() - started
        print(f"\nRun {run}: status={response.status_code}, "
              f"time={elapsed:.2f}s")

        if response.ok:
            result = response.json()
            profiles = [
                profile
                for cluster in result.get("clusters", [])
                for profile in cluster.get("profiles", [])
            ]
            print("Profiles:", len(profiles))
            print("Scores:", [p.get("score") for p in profiles])
        else:
            print("Error:", response.text[:500])

    except requests.RequestException as exc:
        print(f"\nRun {run}: request failed: {exc}")
