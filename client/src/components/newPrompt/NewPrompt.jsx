import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import './newPrompt.css';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useQueryClient } from '@tanstack/react-query';
import { useModel } from '../../context/ModelContext';

/**
 * NewPrompt — handles the "in-progress" message at the bottom of a chat.
 * 
 * Generation lifecycle:
 *   idle → user submits → generating (stream active) → complete (save to DB) → idle
 *   generating → user cancels → save partial → idle
 * 
 * Key design: each generation gets a unique ID. All state updates check
 * "am I still the active generation?" before doing anything. This makes
 * the component immune to React re-renders, remounts, and race conditions.
 */

const NewPrompt = ({
  data,
  setIsTyping,
  isTyping,
  userScrolled,
  setUserScrolled,
  captureScrollPosition,
  chatPageRef,
  chatId,
  onExternalStop,
  onInvestigate,
}) => {
  const { currentModel } = useModel();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [chatMode, setChatMode] = useState('chat'); // 'chat' | 'investigate'
  const [suggestion, setSuggestion] = useState(null);
  const queryClient = useQueryClient();

  // The active generation ID — only the matching generation can update state
  const activeGenRef = useRef(null);
  const formRef = useRef(null);
  const textareaRef = useRef(null);
  const userEndRef = useRef(null);
  const latestMessageRef = useRef(null);
  const endRef = useRef(null);

  const customSystemPrompt = data?.history[0]?.role === 'system'
    ? data.history[0].parts[0].text
    : 'You are a helpful assistant.';

  const prepareChatHistory = (history, lastUserMessage) => {
    const systemMessage = { role: 'system', content: customSystemPrompt };
    const mappedHistory = history.map(({ role, parts }) => ({
      role: role === 'model' ? 'assistant' : role,
      content: parts[0].text,
    }));
    const userMessage = lastUserMessage ? { role: 'user', content: lastUserMessage } : null;
    return [systemMessage, ...mappedHistory, userMessage].filter(Boolean);
  };

  // Scroll effects
  useEffect(() => {
    if (question) userEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [question]);

  useEffect(() => {
    if (answer && isTyping && !userScrolled) {
      latestMessageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [answer]);

  useEffect(() => {
    const chatPageElement = chatPageRef.current;
    const endElement = endRef.current;
    if (chatPageElement && endElement && !userScrolled) {
      const chatPageHeight = chatPageElement.clientHeight;
      const endElementRelativeOffset = endElement.getBoundingClientRect().top - chatPageElement.getBoundingClientRect().top;
      if (endElementRelativeOffset < chatPageHeight - 200) {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [answer, question]);

  /**
   * Core generation function. Returns only when stream is done or cancelled.
   * Uses a generation ID to prevent stale updates.
   */
  const generate = async (text, isInitial) => {
    // Create unique generation ID
    const genId = Symbol('generation');
    activeGenRef.current = genId;

    // Set up UI state
    if (!isInitial) setQuestion(text);
    setIsTyping(true);
    setUserScrolled(false);
    setAnswer('');

    const isActive = () => activeGenRef.current === genId;

    let accumulated = '';
    let abortController = new AbortController();

    // Store abort controller so handleStop can access it
    activeGenRef.current = { id: genId, abort: () => abortController.abort(), accumulated: () => accumulated };

    try {
      const chatHistory = prepareChatHistory(data?.history || [], text);
      const API_URL = import.meta.env.VITE_API_URL || "";

      const res = await fetch(`${API_URL}/api/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ model: currentModel, messages: chatHistory }),
        signal: abortController.signal,
      });

      if (!res.ok) throw new Error(`Gateway error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        // Check if this generation is still active
        if (activeGenRef.current?.id !== genId) {
          reader.cancel().catch(() => {});
          return 'cancelled';
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (activeGenRef.current?.id !== genId) {
          reader.cancel().catch(() => {});
          return 'cancelled';
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop();

        for (const event of events) {
          if (activeGenRef.current?.id !== genId) break;
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              if (payload === "[DONE]") break;
              try {
                const parsed = JSON.parse(payload);
                const content = parsed.choices?.[0]?.delta?.content || "";
                if (content && activeGenRef.current?.id === genId) {
                  accumulated += content;
                  setAnswer(accumulated);
                }
              } catch {}
            }
          }
        }
      }

      // Final check before saving
      if (activeGenRef.current?.id !== genId) return 'cancelled';

      // Stream completed naturally — save to DB
      await saveMessage(text, accumulated, isInitial);
      return 'done';

    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      console.error('Generation error:', err);
      return 'error';
    } finally {
      // Only clean up UI if this generation is still active
      if (activeGenRef.current?.id === genId) {
        activeGenRef.current = null;
        setIsTyping(false);
      }
    }
  };

  /**
   * Save a completed (or partial) message to the DB and refresh the chat.
   */
  const saveMessage = async (questionText, answerText, isInitial) => {
    if (!answerText) return;

    const API_URL = import.meta.env.VITE_API_URL || "";
    await fetch(`${API_URL}/api/chats/${data._id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: (!isInitial && questionText) ? questionText : undefined,
        answer: answerText,
      }),
    });

    // Clear local state and refresh history
    setQuestion('');
    setAnswer('');
    captureScrollPosition();
    await queryClient.invalidateQueries({ queryKey: ['chat', data._id] });
    textareaRef.current?.focus();
  };

  /**
   * Cancel the active generation. Saves partial text to DB.
   */
  const handleStop = () => {
    const gen = activeGenRef.current;
    if (gen) {
      // Cancel NewPrompt's own generation
      const partialText = gen.accumulated();
      const partialQuestion = question;
      gen.abort();
      activeGenRef.current = null;
      setIsTyping(false);

      if (partialText) {
        setQuestion('');
        setAnswer('');
        saveMessage(partialQuestion, partialText, !partialQuestion);
      }
    } else {
      // No active generation in NewPrompt — might be a regeneration in ChatPage
      if (onExternalStop) onExternalStop();
    }
  };

  /**
   * Form submission handler.
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    const text = e.target.text.value;
    if (!text || isTyping) return;
    formRef.current?.reset();

    if (chatMode === 'investigate') {
      if (onInvestigate) {
        onInvestigate(text);
      }
    } else {
      // In chat mode: check if we should suggest investigation first
      // But don't block — just generate normally and show suggestion if triggered
      // The suggestion is for the NEXT time (or user can accept to switch)
      generate(text, false);
      checkShouldInvestigate(text);
    }
  };

  const checkShouldInvestigate = async (text) => {
    try {
      const API_URL = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API_URL}/api/agent/should-investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text }),
      });
      const result = await res.json();
      if (result.suggested) {
        setSuggestion({ ...result, taskText: text });
      }
    } catch {}
  };

  const dismissSuggestion = () => setSuggestion(null);
  const acceptSuggestion = () => {
    const taskText = suggestion?.taskText || question;
    setSuggestion(null);

    // Cancel any in-progress generation (partial response not needed)
    const gen = activeGenRef.current;
    if (gen) {
      gen.abort();
      activeGenRef.current = null;
      setIsTyping(false);
      setAnswer('');
    }

    // Start investigation — handleInvestigate will persist the user message if needed
    if (onInvestigate && taskText) {
      onInvestigate(taskText);
      // Clear local question after refetch settles (prevents duplicate bubble)
      setTimeout(() => setQuestion(''), 500);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  /**
   * Auto-generate on first mount (when navigating from dashboard with a new chat).
   */
  const location = useLocation();
  const hasRun = useRef(false);
  useEffect(() => {
    if (!hasRun.current) {
      const history = data?.history || [];
      if (history.length === 1 && history[0].role === 'user') {
        if (location.state?.autoInvestigate) {
          hasRun.current = true;
          window.history.replaceState({}, '');
          setChatMode('investigate');
          // Strip the 🔬 prefix when passing to onInvestigate (it's already in DB)
          const taskText = data.history[0].parts[0].text.replace(/^🔬\s*/, '');
          if (onInvestigate) onInvestigate(taskText);
        } else if (location.state?.autoGenerate) {
          hasRun.current = true;
          window.history.replaceState({}, '');
          generate(data.history[0].parts[0].text, true);
        }
      }
    }
    hasRun.current = true;
  }, []);

  // Markdown code block renderer
  const components = {
    code: ({ node, inline, className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children).replace(/\n$/, '');
      return !inline && match ? (
        <div className="custom-code-block-wrapper">
          <SyntaxHighlighter
            lineProps={{ style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }}
            wrapLines={true}
            className="custom-code-block"
            style={atomDark}
            language={match[1]}
            PreTag="div"
            {...props}
          >
            {codeString}
          </SyntaxHighlighter>
          <button className="copy-button" onClick={() => navigator.clipboard.writeText(codeString)}>
            Copy
          </button>
        </div>
      ) : (
        <code className={className} {...props}>{children}</code>
      );
    },
  };

  return (
    <>
      {question && (
        <div className="message user">
          <div className="user-message" ref={userEndRef}>{question}</div>
        </div>
      )}
      {answer && (
        <div className="message bot" ref={latestMessageRef}>
          {isTyping && (
            <div className="typing-indicator">
              <div className="typing-icon"></div>
              <div className="typing-icon"></div>
              <div className="typing-icon"></div>
              <span className="typing-text">Typing...</span>
            </div>
          )}
          <ReactMarkdown components={components}>{answer}</ReactMarkdown>
        </div>
      )}
      <div ref={endRef}></div>
      {suggestion && (
        <div className="investigation-suggestion">
          <span className="suggestion-icon">🔬</span>
          <span className="suggestion-text">{suggestion.reason}</span>
          <button className="suggestion-accept" onClick={acceptSuggestion}>Investigate</button>
          <button className="suggestion-dismiss" onClick={dismissSuggestion}>Dismiss</button>
        </div>
      )}
      <form className="newForm" onSubmit={handleSubmit} ref={formRef}>
        <div className="mode-toggle">
          <button
            type="button"
            className={`mode-btn ${chatMode === 'chat' ? 'active' : ''}`}
            onClick={() => setChatMode('chat')}
            data-tooltip="Chat — quick Q&A"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </button>
          <button
            type="button"
            className={`mode-btn ${chatMode === 'investigate' ? 'active' : ''}`}
            onClick={() => setChatMode('investigate')}
            data-tooltip="Investigate — multi-step analysis with sub-agents"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <path d="M8 11h6"/><path d="M11 8v6"/>
            </svg>
          </button>
        </div>
        <input id="file" type="file" multiple={false} hidden />
        <textarea
          name="text"
          placeholder={chatMode === 'investigate' ? "Describe what you'd like to investigate..." : "Ask something..."}
          onKeyDown={handleKeyDown}
          ref={textareaRef}
          disabled={isTyping}
        />
        {isTyping ? (
          <button type="button" onClick={handleStop} className="stop-btn" title="Stop generating">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button type="submit" className={chatMode === 'investigate' ? 'investigate-submit' : ''}>
            {chatMode === 'investigate' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            ) : (
              <img src="/arrow.png" alt="Send" />
            )}
          </button>
        )}
      </form>
    </>
  );
};

export default NewPrompt;
