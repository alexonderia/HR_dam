"""AMQP adapter owned by the FastAPI service lifecycle."""

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pika

from app.config import settings
from app.errors import JobCancelled
from app.job_processor import process_job
from app.job_result import failed_result, infrastructure_error, processing_event, should_retry
from app.job_status import check_job_status
from app.job_validator import validate_analysis_job
from app.ollama_client import ModelUnavailable
from app.rabbitmq_client import create_connection, create_publisher_channel, publish_json, publish_retry
from app.readiness import is_ready
from app.runtime import update_runtime

logger = logging.getLogger(__name__)


def process_checked_job(job: dict, stop_event: threading.Event):
    if stop_event.is_set():
        raise JobCancelled("Consumer is stopping")
    if not check_job_status(job):
        return {"skipped": True, "result": None}
    if not is_ready():
        raise ModelUnavailable("Model is unavailable")
    return {"skipped": False, "result": process_job(job, stop_event=stop_event)}


def resolve_delivery(job: dict, retries: int, outcome=None, error: Exception | None = None) -> dict:
    """Infrastructure retries retain identity and never spend the document budget."""
    if error is None:
        return {"action": "skip" if outcome["skipped"] else "result", "result": outcome["result"]}
    if isinstance(error, JobCancelled):
        return {"action": "requeue"}
    if infrastructure_error(error):
        return {"action": "retry", "retries": retries}
    if should_retry(error, retries):
        return {"action": "retry", "retries": retries + 1}
    return {"action": "result", "result": failed_result(job, error)}


def run_consumer(stop_event: threading.Event):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="resume-analysis")
    active_future = None
    update_runtime(consumer_alive=True)
    try:
        while not stop_event.is_set():
            connection = None
            delivery_in_progress = False
            try:
                connection = create_connection()
                channel = create_publisher_channel(connection)
                channel.basic_qos(prefetch_count=1)

                def on_message(ch, method, properties, body):
                    nonlocal active_future, delivery_in_progress
                    tag = method.delivery_tag
                    if stop_event.is_set():
                        ch.basic_nack(delivery_tag=tag, requeue=True)
                        return
                    try:
                        job = json.loads(body)
                        validate_analysis_job(job)
                        retries = (properties.headers or {}).get("hr-retries", 0)
                        if type(retries) is not int or retries < 0:
                            raise ValueError("Invalid retry counter")
                    except (ValueError, TypeError, KeyError):
                        logger.warning("Invalid AMQP job rejected")
                        ch.basic_nack(delivery_tag=tag, requeue=False)
                        return
                    if not is_ready():
                        publish_retry(ch, job, retries)
                        ch.basic_ack(delivery_tag=tag)
                        return
                    publish_json(ch, settings.RABBITMQ_PROGRESS_QUEUE, processing_event(job), job["job_id"])
                    delivery_in_progress = True
                    active_future = executor.submit(process_checked_job, job, stop_event)

                    def done(future, session=connection, publisher=ch):
                        try:
                            decision = resolve_delivery(job, retries, outcome=future.result())
                        except Exception as exc:
                            logger.warning("AMQP analysis stopped: %s", type(exc).__name__)
                            decision = resolve_delivery(job, retries, error=exc)

                        def finish():
                            nonlocal delivery_in_progress
                            try:
                                if decision["action"] == "requeue":
                                    publisher.basic_nack(delivery_tag=tag, requeue=True)
                                    return
                                if decision["action"] == "retry":
                                    publish_retry(publisher, job, decision["retries"])
                                elif decision["action"] == "result":
                                    publish_json(publisher, settings.RABBITMQ_RESULTS_QUEUE, decision["result"], job["job_id"])
                                publisher.basic_ack(delivery_tag=tag)
                            except Exception:
                                logger.exception("Could not confirm AMQP result; returning unacknowledged delivery")
                                if session.is_open:
                                    session.close()
                            finally:
                                delivery_in_progress = False
                        try:
                            session.add_callback_threadsafe(finish)
                        except pika.exceptions.ConnectionWrongStateError:
                            # Connection loss already returns this unacknowledged delivery.
                            logger.warning("Connection lost before AMQP result confirmation")
                    active_future.add_done_callback(done)

                # Queue exclusivity also protects against consumers with inconsistent environments.
                consumer_tag = channel.basic_consume(queue=settings.RABBITMQ_ANALYSIS_QUEUE,
                    on_message_callback=on_message, auto_ack=False, exclusive=True)
                update_runtime(broker_connected=True)
                logger.info("AMQP adapter connected to %s", settings.RABBITMQ_ANALYSIS_QUEUE)
                shutdown_deadline = None
                while connection.is_open:
                    if stop_event.is_set():
                        if shutdown_deadline is None:
                            shutdown_deadline = time.monotonic() + settings.SHUTDOWN_GRACE_SECONDS
                            channel.basic_cancel(consumer_tag)
                        if not delivery_in_progress or time.monotonic() >= shutdown_deadline:
                            break
                    connection.process_data_events(time_limit=1)
            except Exception:
                logger.exception("AMQP adapter disconnected; waiting to reconnect")
            finally:
                update_runtime(broker_connected=False)
                if connection and connection.is_open:
                    connection.close()
                if active_future is not None:
                    # Do not start another delivery while an old model call is still running.
                    try:
                        active_future.result()
                    except Exception:
                        pass
                    active_future = None
            if not stop_event.is_set():
                stop_event.wait(5)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
        update_runtime(broker_connected=False, consumer_alive=False)
        logger.info("AMQP adapter stopped")


def main():
    # Legacy entrypoint still launches the same HTTP control plane and lifecycle.
    if settings.ANALYZER_ADAPTER != "amqp":
        raise ValueError("Set ANALYZER_ADAPTER=amqp before starting the AMQP adapter")
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, workers=1,
                timeout_graceful_shutdown=int(settings.SHUTDOWN_GRACE_SECONDS))


if __name__ == "__main__":
    main()
