# Resume documents

Shared document functions: `candidate_extractor.extract_contacts`,
`pdf_names.pdf_name_header`, `resume_sections.resume_body` and
`text_extractor.extract_text_from_file`.

No model, vacancy criteria, storage credentials or cross-job cache.
Parser uses only PDF/name/section helpers. Evaluator additionally uses document
text extraction and installs python-docx, striprtf and LibreOffice for DOC.
