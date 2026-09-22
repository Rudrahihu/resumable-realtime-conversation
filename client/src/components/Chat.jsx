import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Connection states are mapped to a label, a tone class, and a short
// line of guidance shown under the composer. Wording stays in the
// interface's voice: say what is happening, then what to do.
const STATE_VIEW = {
  connected: { label: 'Live', tone: 'live' },
  completed: { label: 'Live', tone: 'live' },
  reconnecting: {
    label: 'Reconnecting',
    tone: 'pending',
    hint: 'Reconnecting. Your reply resumes where it left off.',
  },
  disconnected: {
    label: 'Offline',
    tone: 'down',
    hint: 'No connection to the server. Retrying automatically.',
  },
  failed: {
    label: 'Interrupted',
    tone: 'error',
    hint: 'That reply was interrupted. Send another message to continue.',
  },
};

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3.5M8 3.5 3.75 7.75M8 3.5l4.25 4.25"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StreamMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path
        d="M2 10.5c2.2 0 2.2-4.5 4.4-4.5s2.2 4.5 4.4 4.5S13 6 15 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 4.2v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="9.9" r="0.85" fill="currentColor" />
    </svg>
  );
}

export default function Chat({ messages, streamingText, connectionState, isStreaming, onSend }) {
  const [draft, setDraft] = useState('');
  const scrollerRef = useRef(null);
  const inputRef = useRef(null);
  const pinnedRef = useRef(true);

  const view = STATE_VIEW[connectionState] ?? { label: connectionState, tone: 'down' };
  // A send with no socket is silently lost: 'run:started' never arrives,
  // so nothing streams and the draft is gone. Hold the message instead
  // and say why, rather than accepting input the transport can't carry.
  const isOffline = connectionState === 'disconnected' || connectionState === 'reconnecting';
  const canSend = draft.trim().length > 0 && !isStreaming && !isOffline;

  function submit() {
    if (!draft.trim() || isStreaming || isOffline) return;
    onSend(draft);
    setDraft('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit();
  }

  // Enter sends, Shift+Enter breaks the line — same single action the
  // form submit already performed.
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // Grow the composer with its content, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Track whether the reader is pinned to the bottom, so incoming
  // tokens never yank them away from text they scrolled back to read.
  function handleScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, isStreaming]);

  // Return focus to the composer once a reply lands.
  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus();
  }, [isStreaming]);

  const composerDisabled = isStreaming || isOffline;

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__inner">
          <h1 className="masthead__title">Resumable Realtime Conversation</h1>
          <span
            className={`status status--${view.tone}`}
            role="status"
            aria-live="polite"
            title={`Connection: ${view.label}`}
          >
            <span className="status__dot" />
            <span className="status__label">{view.label}</span>
          </span>
        </div>
      </header>

      <main className="transcript" ref={scrollerRef} onScroll={handleScroll}>
        <div className="transcript__inner" role="log" aria-live="polite" aria-relevant="additions text">
          {isEmpty && (
            <div className="blank">
              <span className="blank__mark">
                <StreamMark />
              </span>
              <h2 className="blank__title">Start the conversation</h2>
              <p className="blank__body">
                Replies stream in as they are written. If the connection drops mid-reply, it
                picks up from the last word you received.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="turn turn--user">
                <div className="bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="turn turn--assistant">
                <div className={`reply${m.failed ? ' reply--failed' : ''}`}>
                  {m.content}
                  {m.failed && (
                    <div className="reply__note">
                      <AlertIcon />
                      Reply interrupted before it finished
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {isOffline && (
            <div className="notice">
              <span className="notice__dot" />
              {connectionState === 'reconnecting'
                ? 'Reconnecting — the reply resumes from where it stopped'
                : 'Waiting for the connection to come back'}
            </div>
          )}

          {isStreaming && (
            <div className="turn turn--assistant">
              <div className="reply reply--live">
                {streamingText ? (
                  <>
                    {streamingText}
                    <span className="caret" />
                  </>
                ) : (
                  <span className="reply__waiting" aria-label="Waiting for a reply">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="composer__inner">
          <div className={`field${composerDisabled ? ' field--busy' : ''}`}>
            <label className="visually-hidden" htmlFor="composer-input">
              Message
            </label>
            <textarea
              id="composer-input"
              ref={inputRef}
              className="field__input"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isOffline
                  ? 'Reconnecting…'
                  : isStreaming
                    ? 'Waiting for the reply…'
                    : 'Send a message'
              }
              enterKeyHint="send"
              autoComplete="off"
              disabled={composerDisabled}
            />
            <button type="submit" className="send" disabled={!canSend} aria-label="Send message">
              <SendIcon />
            </button>
          </div>
          <p className="hint">
            {view.hint ?? (
              <>
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
              </>
            )}
          </p>
        </div>
      </form>
    </div>
  );
}
