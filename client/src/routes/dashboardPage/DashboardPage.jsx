import { useState, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useModel } from '../../context/ModelContext';
import './dashboardPage.css';

const API_URL = import.meta.env.VITE_API_URL || "";

const DashboardPage = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const formRef = useRef(null);
  const { currentModel } = useModel();
  const { setActivePanel } = useOutletContext() || {};
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [chatMode, setChatMode] = useState('chat'); // 'chat' | 'investigate'

  useEffect(() => {
    fetch(`${API_URL}/api/suggestions`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => setSuggestions(data.suggestions || []))
      .catch(() => {});
  }, []);

  const mutation = useMutation({
    mutationFn: (text) => {
      return fetch(`${import.meta.env.VITE_API_URL}/api/chats`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chatMode === 'investigate' ? `🔬 ${text}` : text, model: currentModel }),
      }).then(async (res) => {
        if (!res.ok) {
          const errorResponse = await res.json();
          throw new Error(errorResponse.error || 'Error creating chat');
        }
        return res.json();
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['userChats'] });
      navigate(`/dashboard/chats/${data.id}`, {
        state: { autoGenerate: chatMode === 'chat', autoInvestigate: chatMode === 'investigate' },
      });
    },
    onError: (error) => {
      console.error('Mutation error:', error.message);
    },
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const text = formData.get('text');
    if (!text) return;
    mutation.mutate(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formRef.current.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  };

  const handleQuickAction = (text) => {
    mutation.mutate(text);
  };

  return (
    <div className='dashboardPage'>
      <div className="dashboard-center">
        <div className="dashboard-greeting">
          <h1>
            <svg className="lighthouse-logo" width="88" height="88" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="10.1" r="1.0" fill="#7C3AED" opacity="0.10"/>

              <path d="M19.6 5.1 C19.98 6.34 20.36 6.72 21.6 7.1 C20.36 7.48 19.98 7.86 19.6 9.1 C19.22 7.86 18.84 7.48 17.6 7.1 C18.84 6.72 19.22 6.34 19.6 5.1Z" stroke="#7C3AED" strokeWidth="0.55" strokeLinejoin="round" strokeLinecap="round" opacity="0.97" fill="none"/>
              <path d="M11.0 7.0 C11.26 7.82 11.54 8.1 12.36 8.36 C11.54 8.62 11.26 8.9 11.0 9.72 C10.74 8.9 10.46 8.62 9.64 8.36 C10.46 8.1 10.74 7.82 11.0 7.0Z" stroke="#7C3AED" strokeWidth="0.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.76" fill="none"/>
              <path d="M21.8 9.0 C22.0 9.64 22.22 9.86 22.86 10.06 C22.22 10.26 22.0 10.48 21.8 11.12 C21.6 10.48 21.38 10.26 20.74 10.06 C21.38 9.86 21.6 9.64 21.8 9.0Z" stroke="#7C3AED" strokeWidth="0.46" strokeLinejoin="round" strokeLinecap="round" opacity="0.54" fill="none"/>
              <path d="M12.6 11.1 C12.78 11.66 12.98 11.86 13.54 12.04 C12.98 12.22 12.78 12.42 12.6 12.98 C12.42 12.42 12.22 12.22 11.66 12.04 C12.22 11.86 12.42 11.66 12.6 11.1Z" stroke="#7C3AED" strokeWidth="0.42" strokeLinejoin="round" strokeLinecap="round" opacity="0.42" fill="none"/>
              <path d="M17.8 12.0 C17.92 12.38 18.05 12.51 18.43 12.63 C18.05 12.75 17.92 12.88 17.8 13.26 C17.68 12.88 17.55 12.75 17.17 12.63 C17.55 12.51 17.68 12.38 17.8 12.0Z" stroke="#7C3AED" strokeWidth="0.38" strokeLinejoin="round" strokeLinecap="round" opacity="0.30" fill="none"/>

              <path d="M16 4.7V5.4" stroke="#7C3AED" strokeWidth="1.1" strokeLinecap="round" opacity="0.9"/>
              <path d="M14.4 6.1H17.6L18.25 7.9H13.75L14.4 6.1Z" stroke="#7C3AED" strokeWidth="1.0" strokeLinejoin="round" opacity="0.88"/>
              <rect x="13.9" y="7.9" width="4.2" height="1.9" rx="0.45" stroke="#7C3AED" strokeWidth="1.0" opacity="0.88"/>
              <path d="M13.45 10.2H18.55" stroke="#7C3AED" strokeWidth="0.95" strokeLinecap="round" opacity="0.75"/>

              <path d="M14.15 10.2L12.9 24.0H19.1L17.85 10.2" stroke="#7C3AED" strokeWidth="1.0" strokeLinejoin="round" opacity="0.82"/>

              <path d="M13.65 13.6H18.35L18.2 15.3H13.8L13.65 13.6Z" fill="#7C3AED" opacity="0.40"/>
              <path d="M13.28 17.2H18.72L18.56 19.0H13.44L13.28 17.2Z" fill="#7C3AED" opacity="0.40"/>
              <path d="M12.98 20.9H19.02L18.84 22.8H13.16L12.98 20.9Z" fill="#7C3AED" opacity="0.40"/>

              <path d="M15.35 20.2C15.35 19.8 15.67 19.48 16.07 19.48C16.47 19.48 16.79 19.8 16.79 20.2V24H15.35V20.2Z" fill="#7C3AED" opacity="0.10" stroke="#7C3AED" strokeWidth="0.6"/>

              <path d="M12.5 24.4H19.5" stroke="#7C3AED" strokeWidth="1.2" strokeLinecap="round" opacity="0.85"/>

              <path d="M8 26.2C9.2 25.45 10.4 25.45 11.6 26.2C12.8 26.95 14 26.95 15.2 26.2C16.4 25.45 17.6 25.45 18.8 26.2C20 26.95 21.2 26.95 22.4 26.2C23.6 25.45 24.8 25.45 26 26.2" stroke="#7C3AED" strokeWidth="1.1" strokeLinecap="round" opacity="0.40"/>
              <path d="M9 28C10.1 27.4 11.2 27.4 12.3 28C13.4 28.6 14.5 28.6 15.6 28C16.7 27.4 17.8 27.4 18.9 28C20 28.6 21.1 28.6 22.2 28C23.3 27.4 24.4 27.4 25.5 28" stroke="#7C3AED" strokeWidth="0.95" strokeLinecap="round" opacity="0.24"/>
            </svg>
            {import.meta.env.VITE_APP_NAME || 'Lighthouse'}
          </h1>
          <p>What can I help you explore today?</p>
        </div>

        <div className="dashboard-input-wrapper">
          <form onSubmit={handleSubmit} ref={formRef} className="dashboard-form">
            <div className="dashboard-mode-toggle">
              <button
                type="button"
                className={`mode-btn ${chatMode === 'chat' ? 'active' : ''}`}
                onClick={() => setChatMode('chat')}
                title=""
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
                title=""
                data-tooltip="Investigate — multi-step analysis with sub-agents"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  <path d="M8 11h6"/><path d="M11 8v6"/>
                </svg>
              </button>
            </div>
            <textarea
              name='text'
              placeholder={chatMode === 'investigate' ? 'Describe what you\'d like to investigate...' : 'Ask about your data, write a query, or search the wiki...'}
              onKeyDown={handleKeyDown}
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            />
            <button type="submit" className={chatMode === 'investigate' ? 'investigate-submit' : ''}>
              {chatMode === 'investigate' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1L8 15M8 1L3 6M8 1L13 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
              )}
            </button>
          </form>
          {showSuggestions && suggestions.length > 0 && !inputValue && (
            <div className="suggestions-dropdown">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  className="suggestion-item"
                  onMouseDown={(e) => { e.preventDefault(); setInputValue(s); setShowSuggestions(false); mutation.mutate(s); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <span>{s}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="dashboard-actions">
          <button className="dashboard-action" onClick={() => setActivePanel && setActivePanel('wiki')}>
            <span className="action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/><circle cx="19" cy="19" r="3"/><line x1="21" y1="21" x2="23" y2="23"/>
              </svg>
            </span>
            <span className="action-label">Wiki</span>
          </button>
          <button className="dashboard-action" onClick={() => setActivePanel && setActivePanel('query')}>
            <span className="action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><circle cx="19" cy="19" r="3"/><line x1="21" y1="21" x2="23" y2="23"/>
              </svg>
            </span>
            <span className="action-label">Query Editor</span>
          </button>
          <button className="dashboard-action" onClick={() => setActivePanel && setActivePanel('wiki', 'data-catalog.html')}>
            <span className="action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3h18v18H3z"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>
              </svg>
            </span>
            <span className="action-label">Data Catalog</span>
          </button>
          <button className="dashboard-action" onClick={() => setActivePanel && setActivePanel('wiki', 'data-lineage.html')}>
            <span className="action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v3a3 3 0 003 3h6"/><polyline points="15 12 18 15 15 18"/>
              </svg>
            </span>
            <span className="action-label">Lineage Explorer</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
