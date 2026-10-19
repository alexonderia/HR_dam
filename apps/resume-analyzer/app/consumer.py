"""RabbitMQ consumer для обработки резюме."""

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from app.job_processor import process_job
from app.job_result import processing_event
from app.job_result import (
    processing_event,
    failed_result,
    should_retry,
)
from app.readiness import monitor, mark_ready
from app.rabbitmq_client import publish_retry

import pika

from pydantic import ValidationError
from app.job_validator import validate_analysis_job

from uuid import UUID

from app.config import settings
from app.rabbitmq_client import (
    create_connection,
    create_publisher_channel,
    publish_json,
)


logger = logging.getLogger(__name__)


def utc_now() -> str:
    """Текущее время в ISO 8601."""

    return datetime.now(timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def validate_job_envelope(job: dict) -> None:
    """Проверяет обязательные поля задания."""

    if not isinstance(job, dict):
        raise ValueError("Job must be an object")

    if type(job.get("version")) is not int or job["version"] != 1:
        raise ValueError("Unsupported job version")

    for field in ("job_id", "batch_id", "item_id"):
        value = job.get(field)

        if not isinstance(value, str):
            raise ValueError(f"Invalid {field}")

        UUID(value)

    attempt = job.get("attempt")

    if type(attempt) is not int or not 1 <= attempt <= 100:
        raise ValueError("Invalid attempt")

    if not isinstance(job.get("file"), dict):
        raise ValueError("Missing file")

    requirements = job.get("requirements")

    if not isinstance(requirements, list) or not requirements:
        raise ValueError("Missing requirements")


def run_consumer():
    """Запускает consumer RabbitMQ."""

    executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="resume-analysis",
    )

    while True:
        connection = None

        try:
            connection = create_connection()

            channel = create_publisher_channel(connection)

            channel.basic_qos(prefetch_count=1)

            executor = ThreadPoolExecutor(max_workers=1)

            logger.info(
                "Waiting for messages in %s",
                settings.RABBITMQ_ANALYSIS_QUEUE,
            )

            def on_message(ch, method, properties, body):
                delivery_tag = method.delivery_tag

                try:
                    job = json.loads(body)
                    validate_job_envelope(job)\

                    try:
                        validate_analysis_job(job)
                    except (ValidationError, ValueError, TypeError):
                        logger.exception("Invalid analysis job: %s", job_id)
                        ch.basic_nack(
                            delivery_tag=delivery_tag,
                            requeue=False,
                        )
                        return
                    
                    job_id = job["job_id"]

                    headers = properties.headers or {}
                    raw_retries = headers.get("hr-retries", 0)

                    try:
                        retries = int(raw_retries)
                        if retries < 0:
                            raise ValueError("Negative retry count")
                    except (TypeError, ValueError):
                        logger.error("Invalid hr-retries header for job %s", job_id)
                        ch.basic_nack(delivery_tag=delivery_tag, requeue=False)
                        return
                    
                except (ValueError, KeyError, TypeError):
                    logger.exception("Invalid RabbitMQ message")
                    ch.basic_nack(
                        delivery_tag=delivery_tag,
                        requeue=False,
                    )
                    return

                publish_json(
                    channel,
                    settings.RABBITMQ_PROGRESS_QUEUE,
                    processing_event(job),
                    f"{job_id}:processing",
                )

                future = executor.submit(process_job, job)

                def on_done(future):
                    result = None
                    retry_message = None

                    try:
                        result = future.result()

                    except Exception as exc:
                        logger.exception(
                            "Resume processing failed: %s",
                            job_id,
                        )

                        if should_retry(exc, retries):
                            retry_message = job
                        else:
                            result = failed_result(job, exc)

                    def finish():
                        try:
                            if retry_message is not None:
                                publish_retry(channel, retry_message, retries + 1)
                                logger.info(
                                    "Retry scheduled: job_id=%s, retries=%s",
                                    job_id,
                                    retries + 1,
                                )
                            else:
                                publish_json(
                                    channel,
                                    settings.RABBITMQ_RESULTS_QUEUE,
                                    result,
                                    job_id,
                                )

                            ch.basic_ack(delivery_tag=delivery_tag)

                        except Exception:
                            logger.exception(
                                "Could not finalize job %s; reconnecting",
                                job_id,
                            )

                            # Не отправляем ACK.
                            # При закрытии канала RabbitMQ
                            # вернёт неподтверждённое сообщение в очередь.
                            try:
                                if ch.is_open:
                                    ch.close()
                            except Exception:
                                logger.exception(
                                    "Could not close channel for job %s",
                                    job_id,
                                )

                    try:
                        connection.add_callback_threadsafe(finish)

                    except pika.exceptions.ConnectionWrongStateError:
                        logger.error(
                            "Connection closed before completion: %s",
                            job_id,
                        )

                future.add_done_callback(on_done)



            channel.basic_consume(
                queue=settings.RABBITMQ_ANALYSIS_QUEUE,
                on_message_callback=on_message,
                auto_ack=False,
            )

            channel.start_consuming()

        except KeyboardInterrupt:
            logger.info("Consumer stopped")
            break

        except Exception:
            logger.exception(
                "RabbitMQ consumer disconnected; reconnecting"
            )
            time.sleep(5)

        finally:
            if connection and connection.is_open:
                connection.close()



def main():
    """Запускает монитор Ollama и RabbitMQ consumer."""

    logging.basicConfig(level=logging.INFO)

    stop = threading.Event()

    mark_ready(False)

    readiness_thread = threading.Thread(
        target=monitor,
        args=(stop,),
        daemon=True,
        name="ollama-readiness-monitor",
    )

    readiness_thread.start()

    logger.info("Ollama readiness monitor started")

    try:
        run_consumer()

    finally:
        stop.set()
        readiness_thread.join(timeout=5)

        logger.info("Ollama readiness monitor stopped")


if __name__ == "__main__":
    main()
