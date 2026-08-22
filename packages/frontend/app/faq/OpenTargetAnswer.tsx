'use client'

import { useEffect } from 'react'

/**
 * Open the answer a deep link points at.
 *
 * WHY THIS EXISTS. The HTML spec has an "ancestor details revealing algorithm"
 * that is supposed to open a closed `<details>` when navigation targets
 * something inside it, and this page was built on the assumption that it fires
 * for an `id` on the `<summary>`. It does not: measured on `/faq#is-my-data-
 * private`, the summary is found and scrolled to and `details.open` stays
 * `false` in Chromium, Firefox AND WebKit. A minimal hand-written control
 * behaves the same way, so it is the platform and not React. Every permalink on
 * this page is labelled "Link to this answer", and every one of them was
 * sending a reader to a closed row.
 *
 * WHY IT IS SAFE FOR THE NO-JS PROMISE. This is enhancement, not machinery.
 * With JavaScript off, `<details>` still opens on click, still prints when open,
 * is still findable by the browser's own in-page search, and the fragment still
 * scrolls to the right question: the reader just clicks it themselves. Nothing
 * on the page depends on this component existing, which is why it can be a
 * client island on a page that is otherwise entirely server-rendered HTML.
 *
 * It also listens for `hashchange`, because the group nav at the top and the
 * permalinks lower down are same-document links: without that, the second
 * permalink someone follows in a session would do nothing.
 */
export function OpenTargetAnswer() {
  useEffect(() => {
    const open = () => {
      const id = window.location.hash.slice(1)
      if (!id) return
      // `getElementById` rather than `querySelector('#'+id)`: an id is only
      // required to be non-empty, and a CSS selector built from one that starts
      // with a digit throws.
      const target = document.getElementById(id)
      // `closest`, not `parentElement`: the id sits on the summary today, and
      // this keeps working if an answer's id ever moves onto something deeper.
      const details = target?.closest('details')
      if (!details || details.open) return
      details.open = true
      // Re-align after the row grows. The browser scrolled to the summary while
      // the answer was still collapsed, so on a long answer the heading can end
      // up mid-viewport.
      target?.scrollIntoView({ block: 'start', behavior: 'auto' })
    }

    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])

  return null
}
