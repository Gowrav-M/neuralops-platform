import { useState } from 'react';
import { supabase } from '../lib/supabase';

const qaAuthEnabled = import.meta.env.VITE_QA_AUTH_ENABLED === 'true';
const configuredAuthRedirectUrl = import.meta.env.VITE_AUTH_REDIRECT_URL;

function authRedirectUrl() {
  if (configuredAuthRedirectUrl) {
    return configuredAuthRedirectUrl;
  }
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'https://neuralops-platform.vercel.app';
  }
  return window.location.origin;
}

export default function AuthGate({ onSession }) {
  const [mode, setMode] = useState('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [qaToken, setQaToken] = useState('');
  const [message, setMessage] = useState('Production mode requires Supabase login.');
  const [loading, setLoading] = useState(false);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword('');
    setConfirmPassword('');
    setMessage(nextMode === 'sign-up'
      ? 'Create an account. You may need to confirm your email before signing in.'
      : 'Production mode requires Supabase login.');
  };

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

  const handleSignup = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setMessage('Supabase URL or publishable key is missing.');
      return;
    }
    if (password.length < 8) {
      setMessage('Use at least 8 characters for the password.');
      return;
    }
    if (password !== confirmPassword) {
      setMessage('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: email.split('@')[0], neuralops_signup_source: 'production_app' },
        emailRedirectTo: authRedirectUrl(),
      },
    });
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    if (data.session) {
      onSession(data.session);
      return;
    }
    setMode('sign-in');
    setPassword('');
    setConfirmPassword('');
    setMessage('Account created. Check your email to confirm it, then sign in.');
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
      <form className="auth-card" onSubmit={mode === 'sign-up' ? handleSignup : handleLogin}>
        <div>
          <span className="badge badge-warning">AUTH REQUIRED</span>
          <h1 className="page-title" style={{ marginTop: '12px' }}>NeuralOps</h1>
          <p className="page-subtitle">{message}</p>
        </div>
        <div className="auth-mode-switch" aria-label="Authentication mode">
          <button className={mode === 'sign-in' ? 'active' : ''} type="button" onClick={() => switchMode('sign-in')}>
            Existing account
          </button>
          <button className={mode === 'sign-up' ? 'active' : ''} type="button" onClick={() => switchMode('sign-up')}>
            Create account
          </button>
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
        {mode === 'sign-up' && (
          <input
            className="filter-search-input"
            type="password"
            value={confirmPassword}
            placeholder="Confirm password"
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        )}
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? (mode === 'sign-up' ? 'Creating account...' : 'Signing in...') : (mode === 'sign-up' ? 'Create account' : 'Sign in')}
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
