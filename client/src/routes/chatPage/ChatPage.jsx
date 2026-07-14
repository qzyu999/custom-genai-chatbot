import './chatPage.css';
import NewPrompt from '../../components/newPrompt/NewPrompt';
import FooterWithDisclaimer from '../../components/footerWithDisclaimer/FooterWithDisclaimer';
import MessageMenu from '../../components/messageMenu/MessageMenu';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useOutletContext } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import React, { useState, useRef, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronLeft, faChevronRight, faCopy } from '@fortawesome/free-solid-svg-icons';
import throttle from 'lodash/throttle';

const API_URL_QUERY = import.meta.env.VITE_API_URL || "";
const RESULTS_PER_PAGE = 20;
const RESULTS_CAP = 100;

function InlineQueryRunner({ sql, chatId }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [injected, setInjected] = useState(false);

  const runQuery = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    setInjected(false);
    try {
      const res = await fetch(`${API_URL_QUERY}/api/query/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sql }),
      });
      const data = await res.json();
      if (data.metadata?.error) {
        setError(data.metadata.error);
      } else {
        // Cap results
        const cappedRows = (data.rows || []).slice(0, RESULTS_CAP);
        const cappedData = { ...data, rows: cappedRows };
        setResults(cappedData);
        setExpanded(true);
        setPage(0);

        // Inject into chat history so AI can discuss
        if (chatId && cappedRows.length > 0) {
          injectResultsIntoChat(chatId, sql, data.columns || [], cappedRows, (data.rows || []).length);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const injectResultsIntoChat = async (chatId, sql, columns, rows, totalRows) => {
    // Format as markdown table for the AI
    const header = `| ${columns.join(' | ')} |`;
    const separator = `| ${columns.map(() => '---').join(' | ')} |`;
    const rowLines = rows.map(row => `| ${row.map(c => c === null ? 'NULL' : String(c).slice(0, 50)).join(' | ')} |`);
    const truncateNote = rows.length < totalRows
      ? `\n*(Showing first ${rows.length} of ${totalRows} total rows. Refine query for more specific results.)*`
      : '';

    const resultsText = [
      `**Query executed:**\n\`\`\`sql\n${sql}\n\`\`\``,
      `**Results (${rows.length} rows):**`,
      header, separator, ...rowLines,
      truncateNote,
    ].join('\n');

    try {
      await fetch(`${API_URL_QUERY}/api/chats/${chatId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: resultsText }),
      });
      setInjected(true);
    } catch {}
  };

  const totalPages = results ? Math.ceil(results.rows.length / RESULTS_PER_PAGE) : 0;
  const pageRows = results ? results.rows.slice(page * RESULTS_PER_PAGE, (page + 1) * RESULTS_PER_PAGE) : [];

  if (!expanded && !results && !error) {
    return (
      <button className="run-query-button" onClick={runQuery} disabled={loading}>
        {loading ? '⏳ Running...' : '▶ Run'}
      </button>
    );
  }

  return (
    <div className="inline-query-results">
      {error && <div className="inline-query-error">{error}</div>}
      {results && (
        <>
          <div className="inline-query-meta">
            {results.rows.length > 0 && <span>{results.rows.length} rows</span>}
            {results.metadata?.executionTimeMs !== undefined && <span>{results.metadata.executionTimeMs}ms</span>}
            {injected && <span className="inline-query-shared">✓ Shared with AI</span>}
            <button className="inline-query-collapse" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Hide' : 'Show'}
            </button>
          </div>
          {expanded && (
            <>
              <div className="inline-query-table-scroll">
                <table className="inline-query-table">
                  <thead>
                    <tr>{(results.columns || []).map((col, i) => <th key={i}>{col}</th>)}</tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j}>{cell === null ? 'NULL' : String(cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="inline-query-pagination">
                  <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
                  <span>Page {page + 1} of {totalPages}</span>
                  <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

const ChatPage = () => {
  const { openQueryInEditor, openWikiPage, setConversationTokens } = useOutletContext() || {};
  const chatId = useLocation().pathname.split('/').pop();
  const [copied, setCopied] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);
  const [references, setReferences] = useState([]);
  const bottomRef = useRef(null);
  const chatPageRef = useRef(null);
  const scrollPositionRef = useRef(null);
  const regenAbortRef = useRef(null);

  // Variant state for regeneration (ChatGPT-style)
  // variants = array of alternative responses for the last assistant message
  const [variants, setVariants] = useState([]);
  const [variantIndex, setVariantIndex] = useState(0);

  const { isPending, error, data } = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () =>
      fetch(`${import.meta.env.VITE_API_URL}/api/chats/${chatId}`, {
        credentials: 'include',
      }).then((res) => res.json()),
    placeholderData: (prev) => prev, // Keep previous data during refetch to prevent unmount
  });

  // Reset variants when chat data changes (new chat loaded or after mutation)
  useEffect(() => {
    if (data?.history) {
      const history = data.history;
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role !== 'user') {
        // Initialize with the current last assistant message
        setVariants([lastMsg.parts[0].text]);
        setVariantIndex(0);
      } else {
        setVariants([]);
        setVariantIndex(0);
      }
    }
  }, [data]);

  const isCustomChatbot = data?.isCustomChatbot || false;

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const captureScrollPosition = () => {
    if (chatPageRef.current) {
      scrollPositionRef.current = chatPageRef.current.scrollTop;
    }
  };

  const restoreScrollPosition = () => {
    if (chatPageRef.current && scrollPositionRef.current !== null) {
      chatPageRef.current.scrollTop = scrollPositionRef.current;
    }
  };

  useEffect(() => {
    restoreScrollPosition();
    // Extract wiki references from chat history
    if (data?.history) {
      // Estimate conversation tokens (chars / 4)
      const totalChars = data.history.reduce((sum, msg) => {
        return sum + (msg.parts?.[0]?.text?.length || 0);
      }, 0);
      if (setConversationTokens) setConversationTokens(Math.round(totalChars / 4));

      const refs = new Map();
      for (const msg of data.history) {
        if (msg.role !== 'user' && msg.parts?.[0]?.text) {
          const text = msg.parts[0].text;
          // Match markdown links: [text](page.html) or [text](page-id)
          const linkRegex = /\[([^\]]+)\]\(([^)]+\.html?)\)/g;
          let match;
          while ((match = linkRegex.exec(text)) !== null) {
            const title = match[1];
            const pageId = match[2].replace('.html', '');
            if (!refs.has(pageId)) {
              refs.set(pageId, { id: pageId, title, href: match[2] });
            }
          }
          // Match [[wiki:page|title]] format
          const wikiRegex = /\[\[wiki:([^|\]]+)\|?([^\]]*)\]\]/g;
          while ((match = wikiRegex.exec(text)) !== null) {
            const pageId = match[1];
            const title = match[2] || pageId;
            if (!refs.has(pageId)) {
              refs.set(pageId, { id: pageId, title, href: `${pageId}.html` });
            }
          }
        }
      }
      setReferences([...refs.values()]);
    }
  }, [data]);

  const onUserScroll = () => {
    setUserScrolled(true);
  };

  useEffect(() => {
    const chatPageElement = chatPageRef.current;
    const throttledOnUserScroll = throttle(onUserScroll, 3000);

    if (chatPageElement) {
      chatPageElement.addEventListener('wheel', throttledOnUserScroll);
    }

    return () => {
      if (chatPageElement) {
        chatPageElement.removeEventListener('wheel', throttledOnUserScroll);
      }
    };
  }, []);

  // Extract wiki references from a message text
  const extractRefsFromText = (text) => {
    if (!text) return [];
    const refs = new Map();
    // Markdown links: [text](page.html)
    const linkRegex = /\[([^\]]+)\]\(([^)]+\.html?)\)/g;
    let match;
    while ((match = linkRegex.exec(text)) !== null) {
      const title = match[1];
      const href = match[2];
      const pageId = href.replace('.html', '');
      if (!refs.has(pageId)) refs.set(pageId, { id: pageId, title, href });
    }
    // [[wiki:page|title]] format
    const wikiRegex = /\[\[wiki:([^|\]]+)\|?([^\]]*)\]\]/g;
    while ((match = wikiRegex.exec(text)) !== null) {
      const pageId = match[1];
      const title = match[2] || pageId;
      if (!refs.has(pageId)) refs.set(pageId, { id: pageId, title, href: `${pageId}.html` });
    }
    return [...refs.values()];
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleGenerateNew = async () => {
    const history = data?.history || [];

    const apiMessages = [];
    for (const entry of history) {
      if (entry.role === 'system') {
        apiMessages.push({ role: 'system', content: entry.parts[0].text });
      } else if (entry.role === 'user') {
        apiMessages.push({ role: 'user', content: entry.parts[0].text });
      } else {
        apiMessages.push({ role: 'assistant', content: entry.parts[0].text });
      }
    }
    if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
      apiMessages.pop();
    }

    setIsTyping(true);

    // Add empty variant and point to it so streaming text shows live
    const newIdx = variants.length;
    setVariants(prev => [...prev, '']);
    setVariantIndex(newIdx);

    const abortController = new AbortController();
    regenAbortRef.current = abortController;

    try {
      const API_URL = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API_URL}/api/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: apiMessages, model: data.model }),
        signal: abortController.signal,
      });

      if (!res.ok) throw new Error("Failed to regenerate");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        if (abortController.signal.aborted) { reader.cancel().catch(()=>{}); break; }
        const { done, value } = await reader.read();
        if (done || abortController.signal.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop();

        for (const event of events) {
          if (abortController.signal.aborted) break;
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              if (payload === "[DONE]") break;
              try {
                const parsed = JSON.parse(payload);
                const content = parsed.choices?.[0]?.delta?.content || "";
                if (content && !abortController.signal.aborted) {
                  accumulated += content;
                  setVariants(prev => {
                    const updated = [...prev];
                    updated[newIdx] = accumulated;
                    return updated;
                  });
                }
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error("Regeneration failed:", err);
      }
    } finally {
      regenAbortRef.current = null;
      setIsTyping(false);
    }
  };

  const handleStopRegeneration = () => {
    if (regenAbortRef.current) {
      regenAbortRef.current.abort();
      regenAbortRef.current = null;
      setIsTyping(false);
    }
  };

  const messages = data?.history || [];
  const latestMessageIndex = messages.length - 1;

  const components = {
    code: ({ node, inline, className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children).replace(/\n$/, '');
      const isSql = match && match[1].toLowerCase() === 'sql';
      return !inline && match ? (
        <div className="custom-code-block-wrapper">
          <SyntaxHighlighter
            lineProps={{style: {wordBreak: 'break-all', whiteSpace: 'pre-wrap'}}}
            wrapLines={true} 
            className="custom-code-block"
            style={atomDark}
            language={match[1]}
            PreTag="div"
            {...props}
          >
            {codeString}
          </SyntaxHighlighter>
          <div className="code-block-actions">
            <button
              className={`copy-button ${copied ? 'copied' : ''}`}
              onClick={() => handleCopy(codeString)}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            {isSql && openQueryInEditor && (
              <button
                className="open-in-editor-button"
                onClick={() => openQueryInEditor(codeString)}
              >
                Open in Editor ↗
              </button>
            )}
            {isSql && (
              <InlineQueryRunner sql={codeString} chatId={chatId} />
            )}
          </div>
        </div>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    // Intercept links — if they look like wiki pages, open in wiki panel instead
    a: ({ href, children, ...props }) => {
      const isWikiLink = href && (href.endsWith('.html') || href.match(/^[a-z-]+$/));
      if (isWikiLink && openWikiPage) {
        return (
          <button
            className="wiki-link-btn"
            onClick={(e) => { e.preventDefault(); openWikiPage(href); }}
          >
            📖 {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    },
    // Render wiki links: [[wiki:page-id|Display Text]]
    p: ({ children, ...props }) => {
      if (typeof children === 'string' || (Array.isArray(children) && children.some(c => typeof c === 'string' && c.includes('[[wiki:')))) {
        const processWikiLinks = (text) => {
          if (typeof text !== 'string') return text;
          const parts = text.split(/(\[\[wiki:[^\]]+\]\])/g);
          return parts.map((part, i) => {
            const wikiMatch = part.match(/\[\[wiki:([^|]+)\|?([^\]]*)\]\]/);
            if (wikiMatch) {
              const pageId = wikiMatch[1];
              const display = wikiMatch[2] || pageId;
              return (
                <button
                  key={i}
                  className="wiki-link-btn"
                  onClick={() => openWikiPage && openWikiPage(pageId)}
                >
                  📖 {display}
                </button>
              );
            }
            return part;
          });
        };
        return <p {...props}>{Array.isArray(children) ? children.map(c => processWikiLinks(c)) : processWikiLinks(children)}</p>;
      }
      return <p {...props}>{children}</p>;
    },
  };

  // Determine what text to show for a message (variant-aware for last assistant msg)
  const getMessageText = (message, index) => {
    if (index === latestMessageIndex && message.role !== 'user' && variants.length > 0) {
      // During typing (regeneration), show variant even if empty to allow streaming
      if (isTyping && variantIndex === variants.length - 1) {
        return variants[variantIndex] || '';
      }
      return variants[variantIndex] || message.parts[0].text;
    }
    return message.parts[0].text;
  };

  return (
    <div className="chatPage" ref={chatPageRef}>
      <div className="wrapper">
        <div className="chat">
          {isPending ? 'Loading...' : error ? 'Something went wrong!' : data?.history?.map((message, i) => (
            <React.Fragment key={i}>
              {message.role === 'user' ? (
                <div className="message-row user-row">
                  <button className="user-copy-btn" onClick={() => handleCopy(message.parts[0].text)} title="Copy message">
                    <FontAwesomeIcon icon={faCopy} />
                  </button>
                  <div className="message user">
                    <div className="user-message">{message.parts[0].text}</div>
                  </div>
                </div>
              ) : (
                <div className="message bot">
                  <ReactMarkdown components={components}>
                    {getMessageText(message, i)}
                  </ReactMarkdown>
                  {i === latestMessageIndex && variants.length > 1 && (
                    <div className="variant-nav">
                      <button
                        onClick={() => setVariantIndex(Math.max(0, variantIndex - 1))}
                        disabled={variantIndex === 0}
                      >
                        <FontAwesomeIcon icon={faChevronLeft} />
                      </button>
                      <span>{variantIndex + 1} / {variants.length}</span>
                      <button
                        onClick={() => setVariantIndex(Math.min(variants.length - 1, variantIndex + 1))}
                        disabled={variantIndex === variants.length - 1}
                      >
                        <FontAwesomeIcon icon={faChevronRight} />
                      </button>
                    </div>
                  )}
                  <MessageMenu
                    onCopy={() => handleCopy(getMessageText(message, i))}
                    onGenerateNew={handleGenerateNew}
                    showAll={i === latestMessageIndex}
                    isCustomChatbot={isCustomChatbot}
                  />
                  {(() => {
                    const msgRefs = extractRefsFromText(message.parts[0]?.text);
                    return msgRefs.length > 0 ? (
                      <div className="inline-references">
                        <span className="inline-references-label">Sources</span>
                        <div className="inline-references-chips">
                          {msgRefs.map(ref => (
                            <button
                              key={ref.id}
                              className="inline-ref-chip"
                              onClick={() => openWikiPage && openWikiPage(ref.href)}
                            >
                              📖 {ref.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
            </React.Fragment>
          ))}
          <div className="newPromptContainer" ref={bottomRef}>
            {data && <NewPrompt
              key={chatId}
              data={data}
              setIsTyping={setIsTyping}
              isTyping={isTyping}
              userScrolled={userScrolled}
              setUserScrolled={setUserScrolled}
              captureScrollPosition={captureScrollPosition}
              chatPageRef={chatPageRef}
              chatId={chatId}
              onExternalStop={handleStopRegeneration}
            />}
            <FooterWithDisclaimer />
          </div>
        </div>
        <button className="scrollToBottomButton" onClick={scrollToBottom}>
          <FontAwesomeIcon icon={faChevronDown} />
        </button>
      </div>
    </div>
  );
};

export default ChatPage;
