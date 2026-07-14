import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useState, useRef, useCallback, useEffect } from 'react'
import './dashboardLayout.css'
import ChatList from '../../components/chatList/ChatList';
import WikiPage from '../../routes/wikiPage/WikiPage';
import QueryPage from '../../routes/queryPage/QueryPage';

const DashboardLayout = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState('chat');
  const [showAbout, setShowAbout] = useState(false);
  const [contextStats, setContextStats] = useState(null);
  const [conversationTokens, setConversationTokens] = useState(0);

  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || "";
    fetch(`${API_URL}/api/context-stats`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => setContextStats(data))
      .catch(() => {});
  }, []); // 'chat' | 'wiki' | 'query'
  const location = useLocation();
  const navigate = useNavigate();
  const wikiRef = useRef(null);
  const queryRef = useRef(null);

  const switchPanel = (panel, wikiPage) => {
    setActivePanel(panel);
    // Navigate wiki iframe to a specific page if requested
    if (panel === 'wiki' && wikiPage && wikiRef.current) {
      setTimeout(() => wikiRef.current?.navigateTo(wikiPage), 50);
    }
    if (panel === 'chat' && location.pathname === '/dashboard/wiki') {
      navigate('/dashboard');
    }
  };

  // Cross-panel actions (called from chat)
  const openQueryInEditor = useCallback((sql) => {
    setActivePanel('query');
    setTimeout(() => queryRef.current?.addTab(sql), 50);
  }, []);

  const openWikiPage = useCallback((pageId) => {
    setActivePanel('wiki');
    setTimeout(() => wikiRef.current?.navigateTo(pageId.endsWith('.html') ? pageId : `${pageId}.html`), 50);
  }, []);

  return (
    <div className={`dashboardLayout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {!sidebarCollapsed && (
          <div className='menu'>
            <ChatList onCollapse={() => setSidebarCollapsed(true)} onNavigate={() => setActivePanel('chat')} />
          </div>
        )}
        {sidebarCollapsed && (
          <div className="menu-collapsed">
            <button
              className="sidebar-expand-btn"
              onClick={() => setSidebarCollapsed(false)}
              title="Open sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="9" y1="3" x2="9" y2="21"/>
                <polyline points="12 9 15 12 12 15"/>
              </svg>
            </button>
          </div>
        )}

        <div className='content'>
            {/* Chat view — always mounted, hidden when not active */}
            <div className="panel-view" style={{ display: activePanel === 'chat' ? 'flex' : 'none' }}>
              <Outlet context={{ setActivePanel: switchPanel, openQueryInEditor, openWikiPage, setConversationTokens }} />
            </div>
            {/* Wiki view — always mounted to preserve iframe state */}
            <div className="panel-view" style={{ display: activePanel === 'wiki' ? 'flex' : 'none' }}>
              <WikiPage ref={wikiRef} />
            </div>
            {/* Query view */}
            <div className="panel-view" style={{ display: activePanel === 'query' ? 'flex' : 'none' }}>
              <QueryPage ref={queryRef} />
            </div>
        </div>

        {/* Activity bar (right side) */}
        <div className="activity-bar">
          <button
            className={`activity-btn ${activePanel === 'chat' ? 'active' : ''}`}
            onClick={() => switchPanel('chat')}
            title="Chat"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </button>
          <button
            className={`activity-btn ${activePanel === 'wiki' ? 'active' : ''}`}
            onClick={() => switchPanel('wiki')}
            title="Wiki"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/><circle cx="19" cy="19" r="3"/><line x1="21" y1="21" x2="23" y2="23"/>
            </svg>
          </button>
          <button
            className={`activity-btn ${activePanel === 'query' ? 'active' : ''}`}
            onClick={() => switchPanel('query')}
            title="Query Editor"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><circle cx="19" cy="19" r="3"/><line x1="21" y1="21" x2="23" y2="23"/>
            </svg>
          </button>
          <div className="activity-bar-spacer"></div>
          {contextStats && (
            (() => {
              const totalUsed = contextStats.totalTokens + conversationTokens;
              const pct = Math.min(99, Math.round((totalUsed / contextStats.modelLimit) * 100));
              return (
                <div className="context-indicator" title={`Context: ${pct}% used\nSystem: ~${contextStats.totalTokens.toLocaleString()} tokens\nConversation: ~${conversationTokens.toLocaleString()} tokens\nModel: ${contextStats.currentModel} (${contextStats.modelLimit.toLocaleString()} limit)`}>
                  <svg width="28" height="28" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3"/>
                    <circle cx="18" cy="18" r="14" fill="none" stroke={pct > 80 ? '#f59e0b' : '#7c3aed'} strokeWidth="3"
                      strokeDasharray={`${pct * 0.88} 88`}
                      strokeLinecap="round"
                      transform="rotate(-90 18 18)"/>
                  </svg>
                  <span className="context-percent">{pct}%</span>
                </div>
              );
            })()
          )}
          <button
            className="activity-btn activity-btn-info"
            onClick={() => setShowAbout(true)}
            title="How Lighthouse works"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </button>
        </div>

        {showAbout && (
          <div className="about-overlay" onClick={() => setShowAbout(false)}>
            <div className="about-modal" onClick={e => e.stopPropagation()}>
              <div className="about-header">
                <h2>How Lighthouse Works</h2>
                <button className="about-close" onClick={() => setShowAbout(false)}>×</button>
              </div>
              <div className="about-content">
                <div className="about-section">
                  <h3>💬 Chat with Context</h3>
                  <p>Every message you send is enriched with documentation from the wiki, table schemas, and business rules before reaching the AI. This means the AI understands your data model without you explaining it.</p>
                </div>
                <div className="about-section">
                  <h3>📖 Wiki Integration</h3>
                  <p>Documentation is compiled at startup and injected into the AI's context. When the AI cites a page, you can click the link to navigate directly to it.</p>
                </div>
                <div className="about-section">
                  <h3>🔍 Query Engine</h3>
                  <p>SQL suggested by the AI can be opened in the query editor or run directly inline. Results are shared with the AI so you can discuss them.</p>
                </div>
                <div className="about-section">
                  <h3>⚙️ How Context Works</h3>
                  <p>On every API call, Lighthouse injects a layered system prompt:</p>
                  <ol>
                    <li><strong>Identity</strong> — who the AI is and its capabilities</li>
                    <li><strong>Formal Spec</strong> — data primitives, business rules, axioms</li>
                    <li><strong>Schema</strong> — available tables and columns</li>
                    <li><strong>Wiki</strong> — full documentation reference</li>
                    <li><strong>Anchor</strong> — formatting rules reinforced at the end</li>
                  </ol>
                </div>
                <div className="about-section">
                  <h3>🔌 Pluggable</h3>
                  <p>Everything is configurable: LLM provider, wiki source, query engine, and agent delegation. Swap providers without changing code.</p>
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

export default DashboardLayout
