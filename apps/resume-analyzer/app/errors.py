"""Errors shared by document preparation and both transport adapters."""


class JobCancelled(Exception):
    """Service shutdown cancelled work; return its delivery to the queue."""


class JobValidationError(ValueError):
    """The request or result does not match its requirements."""


class DocumentTextError(Exception):
    """The document cannot be decoded into text."""


class InsufficientResumeTextError(ValueError):
    message = "Не удалось извлечь достаточно текста из резюме. Загрузите документ с доступным текстом."

    def __init__(self):
        super().__init__(self.message)
