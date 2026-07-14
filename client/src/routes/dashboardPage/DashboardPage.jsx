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
        body: JSON.stringify({ text, model: currentModel }),
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
      navigate(`/dashboard/chats/${data.id}`, { state: { autoGenerate: true } });
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
            <svg className="lighthouse-logo" width="40" height="40" viewBox="0 0 32 32" fill="none">
              <path d="M16 4L16 6" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M14 6h4l1.2 4.5h-6.4L14 6z" stroke="#7c3aed" strokeWidth="1.2" fill="none"/>
              <rect x="13" y="10.5" width="6" height="2" rx="0.5" stroke="#7c3aed" strokeWidth="1.2" fill="none"/>
              <path d="M13.5 12.5l-1.5 12h8l-1.5-12" stroke="#7c3aed" strokeWidth="1.2" fill="none"/>
              <path d="M11 24.5h10" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M9 7.5l2.5 1" stroke="#7c3aed" strokeWidth="1" strokeLinecap="round" opacity="0.7"/>
              <path d="M23 7.5l-2.5 1" stroke="#7c3aed" strokeWidth="1" strokeLinecap="round" opacity="0.7"/>
              <path d="M6 14l1 2.5L6 19l-1-2.5z" fill="#7c3aed" opacity="0.8"/>
              <path d="M6 14l2.5 1L6 19l-2.5-1z" fill="#7c3aed" opacity="0.4"/>
              <path d="M26 12l0.7 1.8L26 15.5l-0.7-1.8z" fill="#7c3aed" opacity="0.8"/>
              <path d="M26 12l1.8 0.7L26 15.5l-1.8-0.7z" fill="#7c3aed" opacity="0.4"/>
            </svg>
            {import.meta.env.VITE_APP_NAME || 'Lighthouse'}
          </h1>
          <p>What can I help you explore today?</p>
        </div>

        <div className="dashboard-input-wrapper">
          <form onSubmit={handleSubmit} ref={formRef} className="dashboard-form">
            <textarea
              name='text'
              placeholder='Ask about your data, write a query, or search the wiki...'
              onKeyDown={handleKeyDown}
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            />
            <button type="submit">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1L8 15M8 1L3 6M8 1L13 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
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
