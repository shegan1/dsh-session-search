// Client half of dsh-session-search.
// Command-palette style search over the CURRENT session's transcript.
// The index reads the rendered chat flow directly: every conversation row the
// host renders carries the stable [data-chat-anchor-key] contract plus its
// visible text, so search and jump share one version-proof source — no
// assumptions about any client build's session-snapshot internals.
// DOM usage: read-only queries of that contract, plus one self-removing flash
// class on the target row.

window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo, useRef } = React
    const h = React.createElement

    const MAX_RENDERED = 100
    const ROW_TEXT_CAP = 20000

    const PANEL_CSS = [
      '.dsh-ss-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh;z-index:1000;pointer-events:auto;}',
      '.dsh-ss-panel{width:min(640px,92vw);max-height:60vh;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;}',
      '.dsh-ss-inputrow{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:center;}',
      '.dsh-ss-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ss-input{flex:1;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;min-width:0;}',
      '.dsh-ss-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.dsh-ss-list{overflow-y:auto;flex:1;min-height:72px;padding:4px;}',
      '.dsh-ss-row{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-radius:8px;cursor:pointer;}',
      '.dsh-ss-row:hover,.dsh-ss-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ss-badge{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 5px;}',
      '.dsh-ss-snippet{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);display:flex;align-items:baseline;min-width:0;white-space:nowrap;overflow:hidden;}',
      '.dsh-ss-head{flex:0 1 auto;min-width:0;overflow:hidden;direction:rtl;text-align:right;}',
      '.dsh-ss-tail{flex:0 1 auto;min-width:0;overflow:hidden;}',
      '.dsh-ss-chips{display:flex;gap:6px;padding:6px 14px 2px;}',
      '.dsh-ss-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;border-radius:10px;padding:2px 10px;cursor:pointer;}',
      '.dsh-ss-chip[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}',
      '.dsh-ss-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.dsh-ss-mark{background:#ffe100;color:#111;border-radius:3px;padding:0 2px;}',
      '.dsh-ss-hint{padding:26px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;}',
      '.dsh-ss-footer{padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:12px;align-items:center;}',
      '.dsh-ss-count{margin-left:auto;}',
      '.dsh-ss-deep{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11px;padding:0;}',
      '.dsh-ss-deep:disabled{color:var(--dsw-alias-label-secondary);cursor:default;}',
      '.dsh-ss-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;background:transparent;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:0;}',
      '.dsh-ss-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dsh-ss-flash{animation:dsh-ss-flash-anim 1.6s ease-out 1;border-radius:8px;}',
      '@keyframes dsh-ss-flash-anim{0%{box-shadow:0 0 0 3px var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}100%{box-shadow:0 0 0 3px transparent;}}',
      '::highlight(dsh-ss-flash){background-color:#ffe100;color:#111;}',
    ].join('\n')

    // ---------- pure helpers ----------

    /**
     * Role filter groups: user messages, assistant output (steps AND the
     * turn-tail answer row, which is where the assistant's final message and
     * its clock live), everything else (tools, commands, compaction, errors).
     */
    function roleGroup(kind) {
      if (kind === 'user' || kind === 'steering') return 'user'
      if (kind === 'assistant' || kind === 'assistant-step' || kind === 'turn-tail') return 'assistant'
      return 'other'
    }

    function kindLabel(kind) {
      switch (kind) {
        case 'user': return '用户'
        case 'steering': return '插话'
        case 'context': return '上下文'
        case 'assistant': case 'assistant-step': return '助手'
        case 'tool-call': case 'tool-result': return '工具'
        case 'command': case 'command-input': return '命令'
        case 'compaction': case 'manual-compaction': return '压缩'
        case 'turn-error': return '错误'
        case 'turn-tail': case 'turn-trigger': case 'turn-process': return '回合'
        default: return String(kind || '其他')
      }
    }

    /**
     * Deterministic clock source: the host renders message clocks into spans
     * whose CSS-module class ends in `timeStart`/`timeEnd` (hash prefix +
     * stable local name — verified in the installed build's chunk). Querying
     * those spans per row beats trailing-text regexes, which hidden chrome
     * (branch reason, Ran-for readings) silently breaks.
     */
    const CLOCK_LEADING_RE = /^((?:\d{4}年)?\d{1,2}月\d{1,2}日\s*)?((?:[01]?\d|2[0-3]):[0-5]\d)/

    /** Row clock via its dedicated span; falls back to a trailing-text scan. */
    function rowClock(row, raw) {
      const spans = row.querySelectorAll('[class*="timeStart"],[class*="timeEnd"]')
      if (spans.length > 0) {
        const spanText = (spans[spans.length - 1].textContent || '').trim()
        const m = spanText.match(CLOCK_LEADING_RE)
        if (m) {
          const prefix = (m[1] || '').trim()
          return {
            display: prefix ? prefix + ' ' + m[2] : m[2],
            spanText,
            source: 'span',
          }
        }
      }
      // Fallback: trailing clock pattern (date prefix, dot-separated readings).
      const m = raw.match(/((?:\d{4}年)?\d{1,2}月\d{1,2}日\s*)?((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s*·[^·]*)*\s*$/)
      if (m) {
        const prefix = (m[1] || '').trim()
        return { display: prefix ? prefix + ' ' + m[2] : m[2], spanText: null, cutFrom: m.index, source: 'regex' }
      }
      return null
    }

    /**
     * Chronological sort key from a display clock: bare `HH:MM` counts as
     * today; `M月D日 HH:MM` as this year; full `YYYY年M月D日 HH:MM` verbatim.
     * @param display - formatted clock shown on the row.
     * @returns epoch ms, or 0 when unparsable.
     */
    function timeSortKey(display) {
      const m = display.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$|^(\d{1,2}):(\d{2})$/)
      if (!m) return 0
      const now = new Date()
      let year = now.getFullYear()
      let month
      let day
      let hour
      let minute
      if (m[6] !== undefined) {
        hour = Number(m[6])
        minute = Number(m[7])
        month = now.getMonth()
        day = now.getDate()
      } else {
        year = m[1] ? Number(m[1]) : now.getFullYear()
        month = Number(m[2]) - 1
        day = Number(m[3])
        hour = Number(m[4])
        minute = Number(m[5])
      }
      return new Date(year, month, day, hour, minute).getTime()
    }

    /** A row renders in the flow only when it has layout boxes. */
    function rowVisible(row) {
      return row.getClientRects().length > 0
    }

    /**
     * Locate the jump target for an anchor key. Hidden rows (collapsed
     * step-process members) cannot receive scrollIntoView, so an exact-but-
     * hidden match falls to the nearest VISIBLE row in flow order (forward,
     * then backward) — the same neighborhood, actually landable.
     */
    function findJumpRow(key) {
      return locateJumpRow(key).row
    }

    /** findJumpRow with a diagnosable outcome attached. */
    function locateJumpRow(key) {
      const rows = document.querySelectorAll('[data-chat-anchor-key]')
      let hiddenAt = -1
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].getAttribute('data-chat-anchor-key') !== key) continue
        if (rowVisible(rows[i])) return { row: rows[i], detail: { hit: 'exact', flowIndex: i } }
        hiddenAt = i
        break
      }
      if (hiddenAt < 0) {
        // Not in the DOM at all. Distinguish "never rendered" from "unloaded
        // by paging": report the mounted key range for the support loop.
        const total = rows.length
        jumpLog('miss', { key, mountedRows: total })
        return { row: null, detail: { hit: 'absent', mountedRows: total } }
      }
      for (let i = hiddenAt + 1; i < rows.length; i += 1) {
        if (rowVisible(rows[i])) {
          return { row: rows[i], detail: { hit: 'hidden-exact', landedOnFlowIndex: i, hiddenFlowIndex: hiddenAt } }
        }
      }
      for (let i = hiddenAt - 1; i >= 0; i -= 1) {
        if (rowVisible(rows[i])) {
          return { row: rows[i], detail: { hit: 'hidden-exact', landedOnFlowIndex: i, hiddenFlowIndex: hiddenAt } }
        }
      }
      return { row: null, detail: { hit: 'all-hidden', hiddenFlowIndex: hiddenAt } }
    }

    /**
     * Index the rendered chat flow once per panel open. DOM order IS conversation
     * order; each row contributes its anchor key, flow kind, and full text content
     * (textContent keeps collapsed bodies searchable, unlike innerText).
     * Time: the row's own clock span when present (user/steering and turn-tail
     * chrome rows carry it in the DOM even though hover-only visible).
     */
    function buildDomIndex() {
      const rows = document.querySelectorAll('[data-chat-anchor-key]')
      const rows_ = []
      const seen = new Set()
      for (const row of rows) {
        const key = row.getAttribute('data-chat-anchor-key')
        if (!key || seen.has(key)) continue
        // Collapsed step-process members have no layout boxes: they cannot be
        // scrolled to, so indexing them would only create ghost hits.
        if (!rowVisible(row)) continue
        seen.add(key)
        const raw = row.textContent || ''
        const clock = rowClock(row, raw)
        let text = raw
        if (clock) {
          if (clock.spanText !== null && clock.spanText !== '') {
            const at = text.indexOf(clock.spanText)
            if (at >= 0) text = text.slice(0, at) + text.slice(at + clock.spanText.length)
          } else if (clock.cutFrom !== undefined) {
            text = text.slice(0, clock.cutFrom)
          }
        }
        if (text.length > ROW_TEXT_CAP) text = text.slice(0, ROW_TEXT_CAP)
        if (!text.trim()) continue
        const kind = row.getAttribute('data-chat-flow-kind') || ''
        rows_.push({
          key,
          kind,
          group: roleGroup(kind),
          turn: row.getAttribute('data-chat-turn') || '',
          text,
          textLower: text.toLowerCase(),
          time: clock ? clock.display : '',
        })
      }
      // Neighbor inheritance: only user and turn-tail rows carry their own
      // clock. Every other row inherits the nearest clocked row's time — the
      // SAME turn's tail first (its completion time), then the following
      // clocked row, then the previous one. No invented data: rows between
      // two clocked points happened between those two times.
      const clocked = rows_.map((item, i) => (item.time ? i : -1)).filter((i) => i >= 0)
      for (let i = 0; i < rows_.length; i += 1) {
        if (rows_[i].time) continue
        // Same-turn candidates must lie AFTER this row: a mid-turn row belongs
        // to its turn's completion time, not the turn's opening clock.
        const sameTurn = rows_[i].turn
          ? clocked.find((j) => j > i && rows_[j].turn === rows_[i].turn)
          : undefined
        const next = clocked.find((j) => j > i)
        const prev = [...clocked].reverse().find((j) => j < i)
        const pick = sameTurn !== undefined ? sameTurn : next !== undefined ? next : prev
        if (pick !== undefined) rows_[i].time = rows_[pick].time
      }
      // Chronological order: display clocks parse to epoch (bare HH:MM counts
      // as today); unparsable keeps flow position. Stable within one minute.
      rows_.forEach((item, i) => {
        item.sortTs = timeSortKey(item.time)
        item.flowIdx = i
      })
      rows_.sort((a, b) => (a.sortTs - b.sortTs) || (a.flowIdx - b.flowIdx))
      return rows_
    }

    function search(prepared, rawQuery, group) {
      const needle = rawQuery.trim().toLowerCase()
      if (!needle) return []
      const hits = []
      for (const item of prepared) {
        // Default (全部) excludes machine-process rows; explicit 其它 opts in.
        const effective = group || 'user+assistant'
        if (effective === 'user+assistant') {
          if (item.group !== 'user' && item.group !== 'assistant') continue
        } else if (item.group !== effective) {
          continue
        }
        const start = item.textLower.indexOf(needle)
        if (start >= 0) hits.push({ item, start, matchLen: needle.length })
        if (hits.length >= MAX_RENDERED) break
      }
      return hits
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
      return String(value).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, '\\$1')
    }

    function flashRow(row) {
      row.classList.remove('dsh-ss-flash')
      void row.offsetWidth // restart the one-shot animation
      row.classList.add('dsh-ss-flash')
      const clear = () => {
        row.classList.remove('dsh-ss-flash')
        row.removeEventListener('animationend', clear)
      }
      row.addEventListener('animationend', clear)
    }

    /**
     * Keyword-level flash on top of the row flash: register the needle's
     * in-row occurrences with the CSS Custom Highlight API (Electron's
     * Chromium supports it) and blink twice, then unregister. Pure
     * enhancement: any unsupported step falls back to the row flash only.
     */
    let keywordFlashCleanup = null
    function flashKeywordInRow(row, needle) {
      if (keywordFlashCleanup) {
        keywordFlashCleanup()
        keywordFlashCleanup = null
      }
      if (typeof CSS === 'undefined' || typeof Highlight === 'undefined'
        || !CSS.highlights || typeof Range === 'undefined' || !needle) return
      const needleLower = needle.toLowerCase()
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      const ranges = []
      let node = walker.nextNode()
      while (node) {
        const value = node.nodeValue || ''
        const lower = value.toLowerCase()
        let at = lower.indexOf(needleLower)
        while (at >= 0) {
          const range = new Range()
          range.setStart(node, at)
          range.setEnd(node, at + needleLower.length)
          ranges.push(range)
          at = lower.indexOf(needleLower, at + needleLower.length)
        }
        node = walker.nextNode()
      }
      if (ranges.length === 0) return
      const highlight = new Highlight(...ranges)
      let visible = true
      CSS.highlights.set('dsh-ss-flash', highlight)
      const timer = setInterval(() => {
        visible = !visible
        if (visible) CSS.highlights.set('dsh-ss-flash', highlight)
        else CSS.highlights.delete('dsh-ss-flash')
        if (!visible) {
          // After the second blink's off phase, tear down.
          clearInterval(timer)
          keywordFlashCleanup = null
        }
      }, 400)
      keywordFlashCleanup = () => {
        clearInterval(timer)
        CSS.highlights.delete('dsh-ss-flash')
      }
    }

    /** One structured jump log line: every attempt leaves evidence. */
    function jumpLog(event, detail) {
      console.log('[dsh-session-search] jump ' + event, detail)
    }

    /**
     * Deterministic transcript scroll: compute the target's offset inside the
     * scrollport and set scrollTop directly. scrollIntoView walks to the
     * nearest scrollable ancestor and its async programmatic scrolls fight
     * the host's bottom-follow / scroll-anchoring on very long flows, which
     * is exactly the "exact hit but no visible movement" failure mode.
     */
    function scrollToRowCenter(row) {
      const scroller = findScrollContainer()
      if (!scroller) {
        jumpLog('scroll', { mode: 'fallback-scrollIntoView' })
        row.scrollIntoView({ block: 'center' })
        return
      }
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const target = scroller.scrollTop + top - (scroller.clientHeight - row.getBoundingClientRect().height) / 2
      const clamped = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight))
      jumpLog('scroll', { before: Math.round(scroller.scrollTop), target: Math.round(clamped), mode: 'manual' })
      scroller.scrollTop = clamped
    }

    /** Scroll the chat flow row into view, flash the row and the keyword. */
    function jumpToKey(key, needle) {
      const found = locateJumpRow(key)
      jumpLog('direct', { key, ...found.detail })
      if (!found.row) return false
      scrollToRowCenter(found.row)
      requestAnimationFrame(() => {
        scrollToRowCenter(found.row) // second pass: beat bottom-follow/anchoring
        flashRow(found.row)
        flashKeywordInRow(found.row, needle)
      })
      return true
    }

    /**
     * Jump to a row that may not be mounted right now (older history unloads
     * at both window edges): scroll the transcript to its top in steps and
     * retry until the host mounts the row, then center and flash it.
     */
    function jumpToKeyWithLookup(key, needle) {
      const first = locateJumpRow(key)
      jumpLog('lookup-start', { key, ...first.detail })
      if (first.row) {
        scrollToRowCenter(first.row)
        requestAnimationFrame(() => {
          scrollToRowCenter(first.row)
          flashRow(first.row)
          flashKeywordInRow(first.row, needle)
        })
        return
      }
      const scroller = findScrollContainer()
      if (!scroller) {
        jumpLog('lookup-abort', { key, reason: 'no-scroll-container' })
        return
      }
      let tries = 0
      const attempt = async () => {
        const found = locateJumpRow(key)
        if (found.row) {
          jumpLog('lookup-hit', { key, tries, ...found.detail })
          scrollToRowCenter(found.row)
          requestAnimationFrame(() => {
            scrollToRowCenter(found.row)
            flashRow(found.row)
            flashKeywordInRow(found.row, needle)
          })
          return
        }
        if (++tries > 40) {
          jumpLog('lookup-giveup', { key, tries })
          return
        }
        if (scroller.scrollTop <= 1) await sleep(250) // at top, waiting for mounts
        else scroller.scrollTop = 0
        requestAnimationFrame(() => { void attempt() })
      }
      void attempt()
    }

    /** The transcript scrollport: nearest scrollable ancestor of a flow row. */
    function findScrollContainer() {
      const row = document.querySelector('[data-chat-anchor-key]')
      let el = row ? row.parentElement : null
      while (el && el !== document.body) {
        const overflow = getComputedStyle(el).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el
        el = el.parentElement
      }
      return null
    }

    function sleep(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    // ---------- button → panel bridge (registrant-private) ----------

    /** Open state: the session id captured by the header button at click time. */
    function createControl() {
      const listeners = new Set()
      let state = { open: false, sessionId: null }
      const emit = () => { for (const fn of [...listeners]) fn(state) }
      return {
        getState: () => state,
        open(sessionId) { state = { open: true, sessionId: sessionId ?? null }; emit() },
        close() { state = { ...state, open: false }; emit() },
        /** Live session report from the header button's render scope (Ctrl+F source). */
        reportSession(sessionId) {
          if (state.open) return
          state = { ...state, sessionId: sessionId ?? null }
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
    }

    // ---------- components ----------

    function Icon() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true,
      },
      h('circle', { cx: 11, cy: 11, r: 7 }),
      h('line', { x1: 21, y1: 21, x2: 16.5, y2: 16.5 }))
    }

    function Snippet({ text, start, matchLen }) {
      // Window the match with independent trims (90 before / 110 after, capped
      // at the anchors), so the keyword sits near the window's middle even when
      // it starts early or ends late in the row.
      const from = Math.max(0, start - 90)
      const to = Math.min(text.length, start + matchLen + 110)
      const head = (from > 0 ? '…' : '') + text.slice(from, start)
      const mid = text.slice(start, start + matchLen)
      const tail = text.slice(start + matchLen, to) + (to < text.length ? '…' : '')
      const fold = (value) => value.replace(/\s+/g, ' ')
      return h('span', { className: 'dsh-ss-snippet' },
        h('span', { className: 'dsh-ss-head' }, fold(head)),
        h('span', { className: 'dsh-ss-tail' }, h('mark', { className: 'dsh-ss-mark' }, fold(mid)), fold(tail)))
    }

    function ResultRow({ hit, active, onSelect, onHover }) {
      const rowRef = useRef(null)
      useEffect(() => {
        if (active && rowRef.current) rowRef.current.scrollIntoView({ block: 'nearest' })
      }, [active])
      return h('div', {
        className: 'dsh-ss-row',
        'data-active': active || undefined,
        onClick: onSelect,
        onMouseMove: onHover,
        ref: rowRef,
        role: 'option',
        'aria-selected': active || undefined,
      },
      h('span', { className: 'dsh-ss-badge' }, kindLabel(hit.item.kind)),
      hit.item.time && h('span', { className: 'dsh-ss-time' }, hit.item.time),
      h(Snippet, { text: hit.item.text, start: hit.start, matchLen: hit.matchLen }))
    }

    function SearchPanel({ control, getSessionFaceById }) {
      const [controlState, setControlState] = useState(control.getState())
      const [query, setQuery] = useState('')
      const [activeIdx, setActiveIdx] = useState(0)
      const [index, setIndex] = useState([])
      const [group, setGroup] = useState('')
      const [deep, setDeep] = useState({ active: false, indexed: 0, done: false, error: null })
      const deepCancelRef = useRef(false)
      const inputRef = useRef(null)
      const open = controlState.open
      const currentId = controlState.sessionId

      useEffect(() => control.subscribe(setControlState), [control])

      // One DOM scan per open: the rendered flow is the index; row clocks
      // supply the per-row time.
      useEffect(() => {
        if (!open) return
        setQuery('')
        setActiveIdx(0)
        setGroup('')
        deepCancelRef.current = false
        setDeep({ active: false, indexed: 0, done: false, error: null })
        const built = buildDomIndex()
        setIndex(built)
        console.log('[dsh-session-search] indexed rows:', built.length)
        if (inputRef.current) inputRef.current.focus()
      }, [open])

      const hits = useMemo(() => search(index, query, group), [index, query, group])

      const closePanel = () => {
        deepCancelRef.current = true
        control.close()
      }

      const jump = (hit) => {
        const key = hit.item.key
        const needle = query.trim()
        jumpLog('click', { key, needle, indexedFlowKind: hit.item.kind })
        closePanel()
        // A few frames in case the panel's unmount reflows the flow.
        let tries = 0
        const attempt = () => {
          if (++tries > 6) {
            // Still absent (unmounted older history): page back until it mounts.
            jumpToKeyWithLookup(key, needle)
            return
          }
          const found = locateJumpRow(key)
          if (found.row) {
            jumpLog('direct-hit', { key, tries, ...found.detail })
            scrollToRowCenter(found.row)
            requestAnimationFrame(() => {
              scrollToRowCenter(found.row)
              flashRow(found.row)
              flashKeywordInRow(found.row, needle)
            })
          } else {
            requestAnimationFrame(attempt)
          }
        }
        requestAnimationFrame(attempt)
      }

      /**
       * Deep search WITHOUT foreground scrolling: page older history through
       * the session object's own loadOlder() verb (the host's read-time
       * backfill channel — new rows prepend above the viewport, which stays
       * put), re-indexing between pages until two consecutive pages add
       * nothing. Falls back to programmatic top-scrolling only when the
       * session face is unreachable.
       */
      const runDeepSearch = async () => {
        const scroller = findScrollContainer()
        deepCancelRef.current = false
        setDeep({ active: true, indexed: index.length, done: false, error: null })
        const face = currentId ? getSessionFaceById(currentId) : null
        const canLoadOlder = Boolean(face && typeof face.loadOlder === 'function')
        let lastCount = -1
        let stagnant = 0
        let cancelled = false
        try {
          for (let pages = 0; pages < 200; pages += 1) {
            if (deepCancelRef.current) { cancelled = true; return }
            if (canLoadOlder) {
              try {
                await face.loadOlder()
              } catch {
                // A failed page is end-of-history in practice; treat as arrived.
                break
              }
            } else if (scroller) {
              scroller.scrollTop = 0
            } else {
              setDeep({ active: false, indexed: index.length, done: false, error: '未找到聊天滚动容器（当前视图可能不是对话）' })
              return
            }
            await sleep(canLoadOlder ? 120 : 350)
            const fresh = buildDomIndex()
            if (fresh.length <= lastCount) {
              stagnant += 1
              if (stagnant >= 2) break
            } else {
              stagnant = 0
              lastCount = fresh.length
              setIndex(fresh)
              setDeep({ active: true, indexed: fresh.length, done: false, error: null })
            }
          }
          setDeep({ active: false, indexed: lastCount < 0 ? index.length : lastCount, done: true, error: null })
        } finally {
          // Background mode keeps the viewport untouched; only the scroll
          // fallback leaves the reader at the top, so restore the floor there.
          if (!canLoadOlder && scroller) scroller.scrollTop = scroller.scrollHeight
          if (cancelled) setDeep({ active: false, indexed: 0, done: false, error: null })
        }
      }

      const onKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIdx((i) => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const hit = hits[activeIdx]
          if (hit) jump(hit)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          closePanel()
        }
      }

      const hasQuery = query.trim() !== ''
      const truncated = hits.length >= MAX_RENDERED
      const emptyIndex = index.length === 0

      return h(React.Fragment, null,
        h('style', null, PANEL_CSS),
        open && h('div', {
          className: 'dsh-ss-backdrop',
          onMouseDown: (e) => { if (e.target === e.currentTarget) closePanel() },
        },
        h('div', { className: 'dsh-ss-panel', role: 'dialog', 'aria-label': '搜索会话内容' },
          h('div', { className: 'dsh-ss-inputrow' },
            h('span', { className: 'dsh-ss-icon' }, h(Icon)),
            h('input', {
              ref: inputRef,
              className: 'dsh-ss-input',
              placeholder: currentId ? '搜索当前会话内容…' : '当前没有打开的会话',
              value: query,
              onChange: (e) => { setQuery(e.target.value); setActiveIdx(0) },
              onKeyDown,
              'aria-label': '搜索会话内容',
            })),
          h('div', { className: 'dsh-ss-chips', role: 'group', 'aria-label': '角色过滤' },
            [['', '对话'], ['user', '用户'], ['assistant', '助手'], ['other', '其它']].map(([value, label]) =>
              h('button', {
                key: value || 'all',
                className: 'dsh-ss-chip',
                'data-on': group === value || undefined,
                onClick: () => { setGroup(value); setActiveIdx(0) },
              }, label))),
          h('div', { className: 'dsh-ss-list', role: 'listbox', 'aria-label': '搜索结果' },
            emptyIndex
              ? h('div', { className: 'dsh-ss-hint' }, '未找到可搜索的聊天内容，请确认当前已打开会话的对话视图')
              : !hasQuery
                ? h('div', { className: 'dsh-ss-hint' }, '输入关键字，在当前会话已加载的内容中查找')
                : hits.length === 0
                  ? h('div', { className: 'dsh-ss-hint' }, '无匹配结果')
                  : hits.map((hit, i) => h(ResultRow, {
                    key: hit.item.key + ':' + i,
                    hit,
                    active: i === activeIdx,
                    onSelect: () => jump(hit),
                    onHover: () => { setActiveIdx(i) },
                  }))),
          h('div', { className: 'dsh-ss-footer' },
            h('span', null, '↑↓ 选择'),
            h('span', null, 'Enter 跳转'),
            h('span', null, 'Esc 关闭'),
            deep.error && h('span', null, deep.error),
            h('button', {
              className: 'dsh-ss-deep',
              onClick: deep.active
                ? () => { deepCancelRef.current = true }
                : runDeepSearch,
              disabled: deep.done,
              title: deep.done ? '更早内容已全部加载' : '逐页加载更早历史并重建索引',
            },
            deep.active
              ? '深度搜索中… ' + deep.indexed + ' 行 · 点击取消'
              : deep.done
                ? '已加载到顶（' + deep.indexed + ' 行）'
                : '深度搜索（加载更早内容）'),
            h('span', { className: 'dsh-ss-count' },
              hasQuery
                ? (hits.length + (truncated ? '+' : '')) + ' 处命中 · 已索引 ' + index.length + ' 行'
                : '已索引 ' + index.length + ' 行'),
          ))))
    }

    function SearchButton({ control, sessionId }) {
      // Keep the control's session id current on every render (session
      // switches remount the header button), so Ctrl+F always targets the
      // session the user is looking at.
      useEffect(() => {
        control.reportSession(sessionId ?? null)
        return () => { control.reportSession(null) }
      }, [control, sessionId])
      return h('button', {
        className: 'dsh-ss-btn',
        title: '搜索会话内容 (Ctrl+F)',
        'aria-label': '搜索会话内容',
        onClick: () => control.open(sessionId),
      }, h(Icon))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const control = createControl()
        // Session verbs only (loadOlder for background deep search); snapshot
        // content is deliberately not read through this face — the DOM is the
        // version-proof content source.
        const getSessionFaceById = (id) => {
          const sessions = ctx.get('sessions')
          if (!id || !sessions || typeof sessions.binding !== 'function') return null
          const binding = sessions.binding(id)
          return binding && binding.session ? binding.session : null
        }
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'session-search-button', order: 60, label: '搜索会话内容' },
          (props) => h(SearchButton, { control, sessionId: props.sessionId }),
        ))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'session-search-panel', order: 10, label: '会话搜索' },
          () => h(SearchPanel, { control, getSessionFaceById }),
        ))
        // Ctrl+F opens the panel for the currently reported session. Capture
        // phase so the browser's default find (and any host handler) never
        // sees it; text inputs keep Ctrl+F when no session is reported.
        const onKeyDown = (event) => {
          if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'f' || event.key === 'F')) {
            const state = control.getState()
            if (!state.sessionId) return
            event.preventDefault()
            event.stopPropagation()
            control.open(state.sessionId)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        ctx.effect(() => () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (keywordFlashCleanup) keywordFlashCleanup()
        }, 'session-search: Ctrl+F listener')
      },
    }
  },
})
