import { Link } from 'react-router-dom'
import './homepage.css'

const Homepage = () => {
  return (
    <div className='homepage'>
      <div className="hero">
        <div className="hero-badge">Open Source AI Assistant</div>
        <h1>
          <svg className="lighthouse-logo" width="48" height="48" viewBox="0 0 32 32" fill="none">
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
        <p className="hero-subtitle">
          Explore your datalake with natural language. Query tables, browse documentation, 
          and get AI-powered insights — all from one interface.
        </p>
        <div className="hero-actions">
          <Link to='/dashboard' className="hero-btn-primary">Start Chatting</Link>
          <a href="https://github.com/qzyu999/Lighthouse" target="_blank" rel="noopener noreferrer" className="hero-btn-secondary">
            View on GitHub
          </a>
        </div>
      </div>

      <div className="features">
        <div className="feature-card">
          <span className="feature-icon">💬</span>
          <h3>Chat with Your Data</h3>
          <p>Ask questions in plain English. The AI understands your schema and writes queries for you.</p>
        </div>
        <div className="feature-card">
          <span className="feature-icon">📖</span>
          <h3>Built-in Wiki</h3>
          <p>Browse documentation, data catalogs, and lineage diagrams alongside your conversations.</p>
        </div>
        <div className="feature-card">
          <span className="feature-icon">🔌</span>
          <h3>Pluggable Architecture</h3>
          <p>Bring your own LLM provider, wiki source, and query engine. Config-driven, no code changes.</p>
        </div>
      </div>

      <div className="homepage-footer">
        <span>Apache 2.0 License</span>
        <span>·</span>
        <a href="https://github.com/qzyu999/Lighthouse" target="_blank" rel="noopener noreferrer">GitHub</a>
      </div>
    </div>
  )
}

export default Homepage
