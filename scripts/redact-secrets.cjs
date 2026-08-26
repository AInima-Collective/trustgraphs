const URL_TOKEN = /https?:\/\/[^\s"'<>`]+/gi

/**
 * Remove credentials and request details from HTTP(S) URLs before a line is logged.
 * URL.origin deliberately excludes userinfo, while paths, queries, and fragments are replaced
 * with one marker so provider keys are not exposed regardless of where a vendor puts them.
 */
const redactSecrets = (line) =>
  line.replace(URL_TOKEN, (token) => {
    try {
      const url = new URL(token)
      const hasPrivateDetails = Boolean(
        url.username ||
          url.password ||
          (url.pathname && url.pathname !== '/') ||
          url.search ||
          url.hash
      )
      return `${url.origin}${hasPrivateDetails ? '/<redacted>' : ''}`
    } catch {
      return '<redacted-url>'
    }
  })

module.exports = { redactSecrets }
