import { Link, useLocation, useNavigate } from 'react-router-dom';
import './chatList.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FaEllipsisV, FaPlus, FaTrash, FaSearch } from 'react-icons/fa';
import { useState, useEffect, useRef } from 'react';

const ChatList = ({ onCollapse, onNavigate }) => {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const currentChatId = location.pathname.split('/').pop();

  const { isPending, error, data } = useQuery({
    queryKey: ['userChats'],
    queryFn: () =>
      fetch(`${import.meta.env.VITE_API_URL}/api/userchats`, {
        credentials: 'include',
      }).then((res) => res.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (chatId) =>
      fetch(`${import.meta.env.VITE_API_URL}/api/chats/${chatId}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries(['userChats']);
    },
  });

  const handleDelete = (e, chatId) => {
    e.preventDefault();
    e.stopPropagation();
    deleteMutation.mutate(chatId);
    setOpenDropdown(null);
    // Navigate to dashboard if deleting the currently viewed chat
    if (chatId === currentChatId) {
      navigate('/dashboard');
    }
  };

  const [openDropdown, setOpenDropdown] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const searchTimer = useRef(null);

  // Debounced full-text search via backend
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const API_URL = import.meta.env.VITE_API_URL || "";
        const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(searchQuery)}`, { credentials: 'include' });
        const results = await res.json();
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery]);

  // Use search results when searching, otherwise show all chats
  const displayedChats = searchResults !== null
    ? searchResults
    : (data?.slice().reverse() || []);

  const toggleDropdown = (e, chatId) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenDropdown(openDropdown === chatId ? null : chatId);
  };

  return (
    <div className='chatList'>
      <div className="chatList-header">
        <Link to='/dashboard' className="new-chat-btn" onClick={() => onNavigate && onNavigate()}>
          <FaPlus size={12} />
          <span>New Chat</span>
        </Link>
        {onCollapse && (
          <button className="sidebar-collapse-btn" onClick={onCollapse} data-tooltip="Close sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
              <polyline points="14 9 11 12 14 15"/>
            </svg>
          </button>
        )}
      </div>

      <nav className="chatList-nav">
        <Link to='/create-custom-chatbot' className="nav-link">Custom Chatbots</Link>
      </nav>

      <div className="chatList-search">
        <FaSearch size={12} className="chatList-search-icon" />
        <input
          type="text"
          placeholder="Search chats..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="chatList-search-input"
        />
        {searchQuery && (
          <button className="chatList-search-clear" onClick={() => setSearchQuery('')}>
            ✕
          </button>
        )}
      </div>

      <div className="chatList-section-label">Recent</div>

      <div className='chatList-items'>
        {isPending && !searchResults && <div className="chatList-empty">Loading...</div>}
        {error && !searchResults && <div className="chatList-empty">Failed to load</div>}
        {displayedChats.length === 0 && !isPending && (
          <div className="chatList-empty">{searchQuery ? 'No matches found' : 'No conversations yet'}</div>
        )}
        {displayedChats.map((chat) => (
          <Link
            key={chat._id}
            to={`/dashboard/chats/${chat._id}`}
            className={`chatList-item ${currentChatId === chat._id ? 'active' : ''}`}
            onClick={() => onNavigate && onNavigate()}
          >
            <span className="chatList-item-title">{chat.title}</span>
            <button
              className="chatList-item-menu"
              onClick={(e) => toggleDropdown(e, chat._id)}
            >
              <FaEllipsisV size={12} />
            </button>
            {openDropdown === chat._id && (
              <div className="chatList-dropdown">
                <button onClick={(e) => handleDelete(e, chat._id)}>
                  <FaTrash size={11} />
                  <span>Delete</span>
                </button>
              </div>
            )}
          </Link>
        ))}
      </div>

      <div className="chatList-footer">
        <span>{import.meta.env.VITE_APP_NAME || 'Lighthouse'}</span>
      </div>
    </div>
  );
};

export default ChatList;
