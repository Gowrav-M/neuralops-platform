import { useState } from 'react';
import { supabase } from '../lib/supabase';

const qaAuthEnabled = import.meta.env.VITE_QA_AUTH_ENABLED === 'true';

export default function AuthGate({ onSession }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [qaToken, setQaToken] = useState('');
  const [message, setMessage] = useState('Production mode requires Supabase login.');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setMessage('Supabase URL or publishable key is missing.');
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    onSession(data.session);
  };

  const handleQaLogin = (event) => {
    event.preventDefault();
    if (!qaToken.trim()) {
      setMessage('Enter the deployment QA token.');
      return;
    }
    onSession({ access_token: null, qa_token: qaToken.trim(), user: { email: 'deployment-qa@neuralops.local' } });
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleLogin}>
        <div>
          <span className="badge badge-warning">AUTH REQUIRED</span>
          <h1 className="page-title" style={{ marginTop: '12px' }}>NeuralOps</h1>
          <p className="page-subtitle">{message}</p>
        </div>
        <input
          className="filter-search-input"
          type="email"
          value={email}
          placeholder="operator@company.com"
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <input
          className="filter-search-input"
          type="password"
          value={password}
          placeholder="Password"
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      {qaAuthEnabled && (
        <form className="auth-card qa-auth-card" onSubmit={handleQaLogin}>
          <div>
            <span className="badge badge-info">DEPLOYMENT QA</span>
            <h2 className="dark-panel-title" style={{ marginTop: '12px' }}>Automated verification access</h2>
            <p className="page-subtitle">{message}</p>
          </div>
          <input
            className="filter-search-input"
            type="password"
            value={qaToken}
            placeholder="Deployment QA token"
            onChange={(event) => setQaToken(event.target.value)}
            required
          />
          <button className="btn-secondary" type="submit">
            Continue with QA token
          </button>
        </form>
      )}
    </div>
  );
}
