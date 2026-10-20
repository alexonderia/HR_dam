"""RabbitMQ consumer для обработки резюме."""

import json
import logging
import threading
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from app.job_processor import process_job
from app.job_result import (
    processing_event,
    failed_result,
    should_retry,
)

from app.document_loader import (
    DocumentTemporaryError,
    DownloadLinkTemporaryError,
    DocumentDownloadError,
    DownloadLinkError,
)

from app.job_processor import process_job, JobCancelled

from app.job_status import (
    check_job_status,
    JobStatusTemporaryError,
    JobStatusPermanentError,
)

from app.ollama_client import (
    ModelUnavailable,
    ModelTimeout,
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


def process_checked_job(
    job: dict,
    stop_event: threading.Event,
):
    if stop_event.is_set():
        raise JobCancelled("Consumer is stopping")

    should_process = check_job_status(job)

    if stop_event.is_set():
        raise JobCancelled("Consumer is stopping")

    if not should_process:
        return {
            "skipped": True,
            "result": None,
        }

    result = process_job(
        job,
        stop_event=stop_event,
    )

    return {
        "skipped": False,
        "result": result,
    }

def run_consumer():
    """Запускает consumer RabbitMQ."""

    shutdown_started_at = None

    active_future = None
    delivery_in_progress = False

    stop_event = threading.Event()

    def handle_shutdown(signum, frame):
        logger.warning(
            "Shutdown signal received: %s",
            signum,
    )

        stop_event.set()

    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="resume-analysis",
    )

    active_future = None

    while not stop_event.is_set():

        connection = None

        try:
            connection = create_connection()

            channel = create_publisher_channel(connection)

            channel.basic_qos(prefetch_count=1)

            logger.info(
                "Waiting for messages in %s",
                settings.RABBITMQ_ANALYSIS_QUEUE,
            )

            def on_message(ch, method, properties, body):
                delivery_tag = method.delivery_tag

                if stop_event.is_set():
                    logger.info(
                        "Shutdown requested; returning new delivery to RabbitMQ"
                    )

                    ch.basic_nack(
                        delivery_tag=delivery_tag,
                        requeue=True,
                    )
                    return

                try:
                    job = json.loads(body)
                    validate_job_envelope(job)

                    job_id = job["job_id"]

                    try:
                        validate_analysis_job(job)
                    except (ValidationError, ValueError, TypeError):
                        logger.exception("Invalid analysis job: %s", job_id)
                        ch.basic_nack(
                            delivery_tag=delivery_tag,
                            requeue=False,
                        )
                        return

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
                
                nonlocal active_future, delivery_in_progress

                delivery_in_progress = True

                future = executor.submit(
                    process_checked_job,
                    job,
                    stop_event,
                )
                active_future = future

                def on_done(
                    future,
                    session_connection=connection,
                    session_channel=ch,
                ):
                    result = None
                    retry_message = None

                    skipped = False

                    infrastructure_retry = False
                    reject_message = False
                    cancelled = False

                    try:
                        outcome = future.result()

                        if outcome["skipped"]:
                            skipped = True
                        else:
                            result = outcome["result"]

                    except JobCancelled:
                        logger.info(
                            "Resume analysis cancelled: job_id=%s",
                            job_id,
                        )
                        cancelled = True        

                    except JobStatusTemporaryError:
                        logger.exception(
                            "Backend temporarily unavailable: job_id=%s",
                            job_id,
                        )
                        retry_message = job
                        infrastructure_retry = True

                    except JobStatusPermanentError:
                        logger.exception(
                            "Backend rejected job: job_id=%s",
                            job_id,
                        )
                        reject_message = True 

                    except (
                        ModelUnavailable,
                        ModelTimeout,
                        DocumentTemporaryError,
                        DownloadLinkTemporaryError,
                    ):
                        logger.exception(
                            "Temporary infrastructure error: job_id=%s",
                            job_id,
                        )

                        retry_message = job
                        infrastructure_retry = True   

                    except (DownloadLinkError, DocumentDownloadError):
                        logger.exception(
                            "Document access or configuration error: job_id=%s",
                            job_id,
                        )
                        reject_message = True          

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

                        nonlocal delivery_in_progress

                        try:
                            if skipped:
                                logger.info(
                                    "Skipping job: %s",
                                    job_id,
                                )

                            elif cancelled:
                                logger.info(
                                    "Returning cancelled job to RabbitMQ: %s",
                                    job_id,
                                )

                                session_channel.basic_nack(
                                    delivery_tag=delivery_tag,
                                    requeue=True,
                                )

                                delivery_in_progress = False
                                return    

                            elif reject_message:
                                session_channel.basic_nack(
                                    delivery_tag=delivery_tag,
                                    requeue=False,
                                )
                                delivery_in_progress = False
                                return

                            elif infrastructure_retry:
                                publish_retry(
                                    session_channel,
                                    retry_message,
                                    retries,
                                )

                                logger.warning(
                                    "Backend unavailable, retry scheduled: job_id=%s",
                                    job_id,
                                )

                            elif retry_message is not None:
                                publish_retry(
                                    session_channel,
                                    retry_message,
                                    retries + 1,
                                )

                            else:
                                publish_json(
                                    session_channel,
                                    settings.RABBITMQ_RESULTS_QUEUE,
                                    result,
                                    job_id,
                                )

                            session_channel.basic_ack(
                                delivery_tag=delivery_tag,
                            )

                            delivery_in_progress = False

                        except Exception:
                            logger.exception(
                                "Could not finalize job %s; reconnecting",
                                job_id,
                            )

                            # ACK не отправляем.
                            # RabbitMQ повторно доставит сообщение
                            # после закрытия канала.
                            try:
                                if session_channel.is_open:
                                    session_channel.close()
                            except Exception:
                                logger.exception(
                                    "Could not close channel for job %s",
                                    job_id,
                                )

                    try:
                        session_connection.add_callback_threadsafe(finish)

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

            def check_shutdown():
                if not stop_event.is_set():
                    if connection.is_open:
                        connection.call_later(1, check_shutdown)
                    return

                if delivery_in_progress:
                    elapsed = (
                        time.monotonic() - shutdown_started_at
                        if shutdown_started_at is not None
                        else 0
                    )

                    if elapsed < settings.SHUTDOWN_GRACE_SECONDS:
                        logger.info(
                            "Waiting for RabbitMQ delivery to finish: %.1fs",
                            elapsed,
                        )

                        if connection.is_open:
                            connection.call_later(1, check_shutdown)
                        return

                    logger.warning(
                        "Shutdown timeout reached; closing RabbitMQ connection"
                    )

                    # ACK не отправляем: RabbitMQ сможет
                    # повторно доставить неподтверждённое задание.
                    if connection.is_open:
                        connection.close()

                    return

                logger.info("Stopping RabbitMQ consumer")

                if channel.is_open and channel.is_consuming:
                    channel.stop_consuming()

            connection.call_later(1, check_shutdown)

            logger.info(
                "Waiting for messages in %s",
                settings.RABBITMQ_ANALYSIS_QUEUE,
            )

            channel.start_consuming()

        except KeyboardInterrupt:
            logger.info("Consumer stopped")
            break

        except Exception:
            logger.exception(
                "RabbitMQ consumer disconnected; reconnecting"
            )

        finally:
            if connection and connection.is_open:
                connection.close()

            if active_future is not None and not active_future.done():
                logger.warning(
                    "Waiting for active resume analysis before reconnecting"
                )

                try:
                    active_future.result()
                except Exception:
                    logger.exception(
                        "Previous resume analysis finished with error"
                    )

            active_future = None

        if not stop_event.is_set():
            stop_event.wait(5)

    executor.shutdown(wait=True)
    logger.info("Resume analyzer executor stopped")



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
