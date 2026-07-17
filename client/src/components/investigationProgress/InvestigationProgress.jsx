import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './investigationProgress.css';

/**
 * InvestigationProgress — renders the real-time progress of an agent investigation.
 * Collapsible: stays in chat history, can be expanded to review steps and artifacts.
 */
const InvestigationProgress = ({ task, onComplete, onCancel, preloadedResult }) => {
  const [status, setStatus] = useState(preloadedResult ? 'complete' : 'connecting');
  const [steps, setSteps] = useState([]);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(preloadedResult || null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(!!preloadedResult); // Start collapsed if preloaded
  const [stepsCollapsed, setStepsCollapsed] = useState(!!preloadedResult);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!task || preloadedResult) return; // Don't start SSE if preloaded
    startInvestigation();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [task]);

  const startInvestigation = async () => {
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const API_URL = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${API_URL}/api/agent/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ task }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        setError(`Investigation failed: ${res.status}`);
        setStatus('error');
        return;
      }

      setStatus('running');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) {
              const payload = line.slice(6);
              if (payload === '[DONE]') break;
              try {
                const parsed = JSON.parse(payload);
                handleEvent(parsed);
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        setStatus('error');
      }
    }
  };

  const handleEvent = (event) => {
    switch (event.type) {
      case 'started':
        setStatus('running');
        setSteps(prev => [...prev, { type: 'info', detail: event.detail }]);
        break;
      case 'planned':
        setPlan(event.plan);
        setSteps(prev => [...prev, { type: 'plan', detail: event.detail, plan: event.plan }]);
        break;
      case 'executing':
        setSteps(prev => [...prev, { type: 'executing', step: event.step, total: event.total, detail: event.detail }]);
        break;
      case 'step_complete':
        setSteps(prev => {
          const updated = [...prev];
          const idx = updated.findLastIndex(s => s.type === 'executing' && s.step === event.step);
          if (idx >= 0) {
            updated[idx] = { type: 'complete', step: event.step, total: event.total, detail: event.detail, artifact: event.artifact };
          } else {
            updated.push({ type: 'complete', step: event.step, total: event.total, detail: event.detail, artifact: event.artifact });
          }
          return updated;
        });
        break;
      case 'step_failed':
        setSteps(prev => [...prev, { type: 'failed', step: event.step, detail: event.detail }]);
        break;
      case 'synthesizing':
        setStatus('synthesizing');
        setSteps(prev => [...prev, { type: 'info', detail: event.detail }]);
        break;
      case 'complete':
        setStatus('complete');
        setResult(event.result);
        setStepsCollapsed(true); // Auto-collapse steps when result arrives
        if (onComplete) onComplete(event.result);
        break;
      case 'error':
        setStatus('error');
        setError(event.detail);
        break;
      case 'timeout':
        setSteps(prev => [...prev, { type: 'warning', detail: event.detail }]);
        break;
    }
  };

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStatus('error');
    setError('Investigation cancelled');
    if (onCancel) onCancel();
  };

  const components = {
    code: ({ node, inline, className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children).replace(/\n$/, '');
      return !inline && match ? (
        <div className="investigation-code-block">
          <SyntaxHighlighter style={atomDark} language={match[1]} PreTag="div" {...props}>
            {codeString}
          </SyntaxHighlighter>
        </div>
      ) : (
        <code className={className} {...props}>{children}</code>
      );
    },
    table: ({ children }) => (
      <div className="investigation-table-wrapper">
        <table>{children}</table>
      </div>
    ),
  };

  return (
    <div className={`investigation-container ${status === 'complete' ? 'complete' : ''}`}>
      {/* Header — always visible, click to collapse/expand */}
      <div className="investigation-header" onClick={() => status === 'complete' && setCollapsed(!collapsed)}>
        <span className="investigation-icon">🔬</span>
        <span className="investigation-title">Investigation</span>
        <div className="investigation-header-actions">
          {(status === 'running' || status === 'synthesizing') && (
            <button className="investigation-cancel" onClick={(e) => { e.stopPropagation(); handleCancel(); }}>Cancel</button>
          )}
          {status === 'complete' && <span className="investigation-badge complete">Complete</span>}
          {status === 'error' && <span className="investigation-badge error">Failed</span>}
          {status === 'complete' && (
            <button className="investigation-toggle" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
              {collapsed ? '▸' : '▾'}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Steps section — collapsible separately */}
          <div className="investigation-steps-section">
            <button className="steps-toggle" onClick={() => setStepsCollapsed(!stepsCollapsed)}>
              <span>{stepsCollapsed ? '▸' : '▾'}</span>
              <span>Steps ({steps.filter(s => s.type === 'complete').length}/{steps.filter(s => s.step).length || '...'})</span>
            </button>
            {!stepsCollapsed && (
              <div className="investigation-steps">
                {steps.map((step, i) => (
                  <div key={i} className={`investigation-step step-${step.type}`}>
                    <span className="step-indicator">
                      {step.type === 'executing' && <span className="step-spinner" />}
                      {step.type === 'complete' && '✓'}
                      {step.type === 'failed' && '✗'}
                      {step.type === 'info' && '○'}
                      {step.type === 'plan' && '◉'}
                      {step.type === 'warning' && '⚠'}
                    </span>
                    <span className="step-detail">{step.detail}</span>
                  </div>
                ))}
                {status === 'synthesizing' && (
                  <div className="investigation-step step-executing">
                    <span className="step-indicator"><span className="step-spinner" /></span>
                    <span className="step-detail">Synthesizing findings...</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Result */}
          {result && (
            <div className="investigation-result">
              <div className="investigation-result-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                  {result.summary}
                </ReactMarkdown>
              </div>

              {result.artifacts?.length > 0 && (
                <div className="investigation-artifacts">
                  <div className="artifacts-header">Artifacts</div>
                  {result.artifacts.map((artifact, i) => (
                    <div key={i} className="artifact-card">
                      <div className="artifact-card-title">
                        {artifact.type === 'sql' && '📝 '}
                        {artifact.type === 'table' && '📊 '}
                        {artifact.type === 'insight' && '💡 '}
                        {artifact.type === 'chart_data' && '📈 '}
                        {artifact.title}
                      </div>
                      <div className="artifact-card-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                          {artifact.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {result.duration && (
                <div className="investigation-duration">
                  Completed in {(result.duration / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          )}

          {error && <div className="investigation-error">{error}</div>}
        </>
      )}
    </div>
  );
};

export default InvestigationProgress;
