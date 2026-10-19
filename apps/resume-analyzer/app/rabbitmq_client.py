"""Подключение к RabbitMQ и публикация сообщений."""

import json
import logging

import pika

from app.config import settings


logger = logging.getLogger(__name__)


def create_connection() -> pika.BlockingConnection:
    """Создаёт соединение с RabbitMQ."""

    credentials = pika.PlainCredentials(
        settings.RABBITMQ_USER,
        settings.RABBITMQ_PASSWORD,
    )

    parameters = pika.ConnectionParameters(
        host=settings.RABBITMQ_HOST,
        port=settings.RABBITMQ_PORT,
        virtual_host=settings.RABBITMQ_VHOST,
        credentials=credentials,
        heartbeat=60,
        blocked_connection_timeout=30,
        connection_attempts=5,
        retry_delay=5,
    )

    return pika.BlockingConnection(parameters)


def create_publisher_channel(connection):
    """Создаёт канал с подтверждением публикации."""

    channel = connection.channel()

    channel.confirm_delivery()

    return channel

def publish_retry(channel, job: dict, retries: int):
    publish_json(
        channel=channel,
        queue_name=f"{settings.RABBITMQ_ANALYSIS_QUEUE}.retry",
        message=job,
        message_id=job["job_id"],
        headers={"hr-retries": retries},
    )


def publish_json(
    channel,
    queue_name: str,
    message: dict,
    message_id: str,
    headers: dict | None = None,
):
    body = json.dumps(message, ensure_ascii=False).encode("utf-8")

    published = channel.basic_publish(
        exchange="",
        routing_key=queue_name,
        body=body,
        mandatory=True,
        properties=pika.BasicProperties(
            content_type="application/json",
            delivery_mode=2,
            message_id=message_id,
            correlation_id=message["job_id"],
            headers=headers or {},
        ),
    )

    if published is False:
        raise RuntimeError(f"Failed to publish message to {queue_name}")