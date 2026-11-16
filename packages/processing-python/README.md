# Processing runtime

Shared Python transport for `resume_parser` and `resume_evaluator`.
Public modules: `processing_runtime.protocol` (commands/job identity/errors),
`processing_runtime.api` (scoped `JobAPI`), `processing_runtime.worker`
(`run(operation, processor, ...)`, two vhost connections and one executor).

This package imports neither service, model code nor document extraction.
Files are downloaded through the current job API; ACK follows accepted result.
Each service copies this source package into its own image.
