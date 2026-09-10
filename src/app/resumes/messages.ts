type ResumePageQuery = Record<string, string | string[] | undefined>;

const errorMessages: Record<string, string> = {
  FILE_REQUIRED: "请至少选择一个 DOCX 源文件或 PDF 投递文件。",
  RESUME_FILE_REQUIRED: "请至少选择一个 DOCX 源文件或 PDF 投递文件。",
  EMPTY_FILE: "所选文件是空文件，请重新选择。",
  FILE_TOO_LARGE: "文件超过 10 MB，请压缩或重新导出后再试。",
  INVALID_FILE_TYPE: "文件格式不受支持，请分别选择 DOCX 源文件或 PDF 投递文件。",
  UNSUPPORTED_MEDIA_TYPE: "文件格式不受支持，请分别选择 DOCX 源文件或 PDF 投递文件。",
  UNSUPPORTED_FILE_TYPE: "文件格式不受支持，请选择 `.docx` 或 `.pdf` 文件。",
  MIME_MISMATCH: "文件类型与扩展名不一致，请重新导出后再上传。",
  INVALID_FILE_NAME: "文件名无效，请重命名后再上传。",
  INVALID_FILE_CONTENT: "文件内容与扩展名不一致或已经损坏，请重新导出后再试。",
  INVALID_FILE_SIGNATURE: "文件内容与所选格式不一致，请重新选择。",
  INVALID_DOCX_PACKAGE: "DOCX 文件结构无效，请用 Word 或兼容软件重新保存。",
  INVALID_DOCX: "DOCX 文件无法识别，请确认它是有效的 Word 文档。",
  INVALID_PDF: "PDF 文件无法识别，请重新导出后再试。",
  INVALID_FORM: "提交内容不完整，请检查简历信息和所选文件。",
  VALIDATION_ERROR: "提交内容不符合要求，请检查各项信息后再试。",
  RESUME_NOT_FOUND: "没有找到这份简历，它可能已被移除。",
  RESUME_ARCHIVED: "这份简历已归档，恢复后才能添加新版本。",
  RESUME_CREATE_FAILED: "简历没有成功创建，请稍后重试。",
  RESUME_VERSION_CREATE_FAILED: "新版本没有成功保存，请稍后重试。",
  CONCURRENT_MODIFICATION: "简历内容刚刚发生变化，请刷新页面后重试。",
  VERSION_CONFLICT: "简历内容已经变化，请刷新页面后重试。",
  STORAGE_ERROR: "文件暂时无法保存，请确认本地磁盘可用后重试。",
  FILE_WRITE_FAILED: "文件暂时无法保存，请确认本地磁盘可用后重试。",
  UPLOAD_FAILED: "文件保存失败，请核对文件后重试。",
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function getResumePageMessage(query: ResumePageQuery) {
  const error = first(query.error);
  if (error) {
    return {
      kind: "error" as const,
      text: errorMessages[error] ?? "没有保存成功，请重试。",
    };
  }
  if (first(query.created)) {
    return {
      kind: "success" as const,
      text: "简历已创建，首个文件版本已安全保存在本机。",
    };
  }
  if (first(query.versionAdded)) {
    return {
      kind: "success" as const,
      text: "新版本已保存，旧版本仍保留在版本历史中。",
    };
  }
  return null;
}
