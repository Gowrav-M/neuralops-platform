import { useState, useEffect, useCallback } from 'react';
import './index.css';
import { fetchDashboard, fetchSystemStatus, setApiAuthToken } from './lib/api';
import { AUTH_ENABLED, supabase } from './lib/supabase';

// Import Screens
import Overview from './components/Overview';
import TraceExplorer from './components/TraceExplorer';
import PromptRegistry from './components/PromptRegistry';
import EvalCenter from './components/EvalCenter';
import RAGQuality from './components/RAGQuality';
import CostDashboard from './components/CostDashboard';
import PolicyManager from './components/PolicyManager';
import IncidentTimeline from './components/IncidentTimeline';
import Agents from './components/Agents';
import NeuralLabs from './components/NeuralLabs';
import ConnectCenter from './components/ConnectCenter';
import EvidenceCenter from './components/EvidenceCenter';
import AutomationCenter from './components/AutomationCenter';
import ReleaseAutopilot from './components/ReleaseAutopilot';
import Settings from './components/Settings';
import AuthGate from './components/AuthGate';

const getNavIcon = (tab) => {
  switch (tab) {
    case 'Dashboard':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="9" />
          <rect x="14" y="3" width="7" height="5" />
          <rect x="14" y="12" width="7" height="9" />
          <rect x="3" y="16" width="7" height="5" />
        </svg>
      );
    case 'Traces':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      );
    case 'Prompts':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 13h8" />
          <path d="M8 17h8" />
          <path d="M10 9H8" />
        </svg>
      );
    case 'Evaluations':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'RAG Quality':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </svg>
      );
    case 'Cost':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      );
    case 'Policies':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case 'Incidents':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'Agents':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case 'Labs':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 2v6.5L4.2 18.8A2 2 0 0 0 6 22h12a2 2 0 0 0 1.8-3.2L14 8.5V2" />
          <path d="M8 2h8" />
          <path d="M7.2 16h9.6" />
        </svg>
      );
    case 'Connect':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
    case 'Evidence':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case 'Automations':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4v6h6" />
          <path d="M20 20v-6h-6" />
          <path d="M20 9a7 7 0 0 0-12-4.9L4 10" />
          <path d="M4 15a7 7 0 0 0 12 4.9L20 14" />
        </svg>
      );
    case 'Autopilot':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v4" />
          <path d="M12 18v4" />
          <path d="m4.93 4.93 2.83 2.83" />
          <path d="m16.24 16.24 2.83 2.83" />
          <path d="M2 12h4" />
          <path d="M18 12h4" />
          <path d="m4.93 19.07 2.83-2.83" />
          <path d="m16.24 7.76 2.83-2.83" />
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
    case 'Settings':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
};

const workflowStages = [
  { label: 'Ingest', tab: 'Connect', detail: 'SDK, REST, OTEL' },
  { label: 'Test', tab: 'Labs', detail: 'Agents and evals' },
  { label: 'Replay', tab: 'Autopilot', detail: 'Regression proof' },
  { label: 'Gate', tab: 'Evidence', detail: 'Release proof' },
  { label: 'Act', tab: 'Automations', detail: 'Rules and incidents' },
  { label: 'Monitor', tab: 'Dashboard', detail: 'Traces and cost' },
  { label: 'Investigate', tab: 'Traces', detail: 'Replay failures' },
  { label: 'Configure', tab: 'Settings', detail: 'Providers and auth' },
];

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('neuralops-theme') || 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('neuralops-theme', theme);
  }, [theme]);

  const [activeTab, setActiveTab] = useState('Dashboard');
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdSearch, setCmdSearch] = useState('');
  const [toasts, setToasts] = useState([]);
  const [apiStatus, setApiStatus] = useState({ state: 'loading', message: 'Connecting to FastAPI backend...' });
  const [systemStatus, setSystemStatus] = useState(null);
  const [session, setSession] = useState(null);

  useEffect(() => {
    if (!AUTH_ENABLED || !supabase) return undefined;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setApiAuthToken(data.session?.access_token || null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setApiAuthToken(nextSession?.access_token || null);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Uptime/realtime timer
  const [timerSeconds, setTimerSeconds] = useState(155); // 02:35 initial
  const [timerActive, setTimerActive] = useState(true);

  const [stats, setStats] = useState({
    totalRequests: 0,
    avgLatency: '0.00s',
    p95Latency: '0.00s',
    errorRate: '0.0%',
    totalCost: '$0.000',
    evalPassRate: '0.0%',
    policyViolations: 0,
    activeIncidents: 0
  });

  const [incidents, setIncidents] = useState([]);
  const [traces, setTraces] = useState([]);

  useEffect(() => {
    if (AUTH_ENABLED && !session) return undefined;
    let cancelled = false;

    Promise.all([fetchDashboard(), fetchSystemStatus()])
      .then(([snapshot, status]) => {
        if (cancelled) return;
        setStats(snapshot.stats);
        setTraces(snapshot.traces);
        setIncidents(snapshot.incidents);
        setSystemStatus(status);
        setApiStatus({ state: 'connected', message: 'Live backend data store connected' });
      })
      .catch(() => {
        if (cancelled) return;
        setApiStatus({ state: 'offline', message: 'Backend offline - no local sample data is being shown' });
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Web Audio synthesizer for crisp physical haptic audio notes
  const playAudioCue = useCallback((type = 'click') => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'click') {
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      } else if (type === 'success') {
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.setValueAtTime(900, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'warning') {
        osc.frequency.setValueAtTime(320, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(280, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'error') {
        osc.frequency.setValueAtTime(180, ctx.currentTime);
        osc.frequency.setValueAtTime(140, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch {
      // AudioContext blocked
    }
  }, []);

  // Toast adder helper with audio triggers
  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);

    // Trigger synthesized tactile sound matching the severity
    playAudioCue(type);

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, [playAudioCue]);

  // Local visual anomaly marker for operator drills; it never mutates backend records.
  const [chaosActive, setChaosActive] = useState(false);

  const refreshDashboard = () => {
    Promise.all([fetchDashboard(), fetchSystemStatus()])
      .then(([snapshot, status]) => {
        setStats(snapshot.stats);
        setTraces(snapshot.traces);
        setIncidents(snapshot.incidents);
        setSystemStatus(status);
        setApiStatus({ state: 'connected', message: 'Live backend data store connected' });
      })
      .catch(() => {
        setApiStatus({ state: 'offline', message: 'Backend offline - no local sample data is being shown' });
      });
  };

  const toggleChaosMode = () => {
    const nextChaos = !chaosActive;
    setChaosActive(nextChaos);
    if (nextChaos) {
      addToast('Scenario marker enabled. Existing backend data is unchanged.', 'warning');
    } else {
      refreshDashboard();
      addToast('Scenario marker cleared. Dashboard refreshed from backend.', 'success');
    }
  };

  // Time formatting (02:35 format)
  const formatTime = (secs) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  };

  // Uptime clock ticking logic
  useEffect(() => {
    let interval = null;
    if (timerActive) {
      interval = setInterval(() => {
        setTimerSeconds(prev => prev + 1);

      }, 1000);
    }
    return () => clearInterval(interval);
  }, [timerActive]);

  // Global keydown listeners (Ctrl+K palette)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Nav menu item click
  const handleNavClick = (tab) => {
    setActiveTab(tab);
    setCmdPaletteOpen(false);
  };

  const navItems = [
    'Dashboard',
    'Traces',
    'Prompts',
    'Evaluations',
    'RAG Quality',
    'Cost',
    'Policies',
    'Incidents',
    'Agents',
    'Labs',
    'Connect',
    'Autopilot',
    'Evidence',
    'Automations',
    'Settings'
  ];

  // Map active tab to component
  const renderActiveScreen = () => {
    switch (activeTab) {
      case 'Dashboard':
        return (
          <Overview
            stats={stats}
            traces={traces}
            incidents={incidents}
            systemStatus={systemStatus}
            apiStatus={apiStatus}
            setActiveTab={setActiveTab}
            setSelectedTrace={setSelectedTrace}
            setDrawerOpen={setDrawerOpen}
            timerActive={timerActive}
            setTimerActive={setTimerActive}
            timerSeconds={timerSeconds}
            formatTime={formatTime}
          />
        );
      case 'Traces':
        return (
          <TraceExplorer
            traces={traces}
            selectedTrace={selectedTrace}
            setSelectedTrace={setSelectedTrace}
            drawerOpen={drawerOpen}
            setDrawerOpen={setDrawerOpen}
          />
        );
      case 'Prompts':
        return <PromptRegistry addToast={addToast} />;
      case 'Evaluations':
        return <EvalCenter addToast={addToast} />;
      case 'RAG Quality':
        return <RAGQuality addToast={addToast} />;
      case 'Cost':
        return <CostDashboard addToast={addToast} />;
      case 'Policies':
        return <PolicyManager addToast={addToast} />;
      case 'Incidents':
        return (
          <IncidentTimeline
            incidents={incidents}
            setIncidents={setIncidents}
            addToast={addToast}
          />
        );
      case 'Agents':
        return <Agents addToast={addToast} />;
      case 'Labs':
        return <NeuralLabs addToast={addToast} refreshDashboard={refreshDashboard} />;
      case 'Connect':
        return <ConnectCenter addToast={addToast} refreshDashboard={refreshDashboard} />;
      case 'Autopilot':
        return <ReleaseAutopilot addToast={addToast} />;
      case 'Evidence':
        return <EvidenceCenter addToast={addToast} />;
      case 'Automations':
        return <AutomationCenter addToast={addToast} />;
      case 'Settings':
        return <Settings addToast={addToast} />;
      default:
        return <Overview stats={stats} traces={traces} incidents={incidents} />;
    }
  };

  // Command palette search filtering
  const filteredCommands = navItems.filter(cmd =>
    cmd.toLowerCase().includes(cmdSearch.toLowerCase())
  );

  if (AUTH_ENABLED && !session) {
    return <AuthGate onSession={(nextSession) => {
      setSession(nextSession);
      setApiAuthToken(nextSession?.access_token || null);
    }} />;
  }

  return (
    <div className="dashboard-wrapper">
      {/* Left Sidebar Panel */}
      <aside className="sidebar-container">
        {/* Brand Logo with dynamic animated SVG */}
        <button className="sidebar-logo" onClick={() => handleNavClick('Dashboard')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          NeuralOps
        </button>

        {/* Sidebar Navigation Items */}
        <div className="sidebar-nav-list">
          {navItems.map((tab) => (
            <button
              key={tab}
              className={`sidebar-nav-item ${activeTab === tab ? 'active' : ''}`}
              onClick={() => handleNavClick(tab)}
            >
              {getNavIcon(tab)}
              {tab}
            </button>
          ))}
        </div>

        {/* Backend-derived workspace summary */}
        <div className="sidebar-meta-card">
          <div style={{ display: 'grid', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>API</span>
              <span className={`badge ${apiStatus.state === 'connected' ? 'badge-success' : apiStatus.state === 'loading' ? 'badge-warning' : 'badge-error'}`} style={{ fontSize: '8px' }}>
                {apiStatus.state}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>Traces</span>
              <span className="code-font">{traces.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>Incidents</span>
              <span className="code-font">{incidents.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>DB</span>
              <span className="code-font">{systemStatus?.storage || 'checking'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>Auth</span>
              <span className={`badge ${systemStatus?.authRequired ? 'badge-success' : 'badge-warning'}`} style={{ fontSize: '8px' }}>
                {systemStatus?.authRequired ? 'enabled' : 'local'}
              </span>
            </div>
            <button className="btn-secondary" style={{ padding: '6px 10px', fontSize: '10px' }} onClick={refreshDashboard}>
              Refresh Backend
            </button>
          </div>
        </div>

        {/* Unified Light/Dark Theme Switcher Pill */}
        <div className="theme-switch-container">
          <button
            className={`theme-switch-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => { playAudioCue('click'); setTheme('light'); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            Light
          </button>
          <button
            className={`theme-switch-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => { playAudioCue('click'); setTheme('dark'); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            Dark
          </button>
        </div>

        {/* Operator profile card bottom */}
        <div className="sidebar-profile" onClick={() => handleNavClick('Settings')}>
          <div className="avatar-circle" style={{ width: '36px', height: '36px' }}>
            <div className="avatar-initials" aria-label="NeuralOps operator avatar">NO</div>
          </div>
          <div className="sidebar-profile-info">
            <span className="sidebar-profile-name">Local Workspace</span>
            <span className="sidebar-profile-role">{apiStatus.state === 'connected' ? 'Backend connected' : 'Backend unavailable'}</span>
          </div>
          <span className="sidebar-profile-badge">{traces.length} traces</span>
        </div>
      </aside>

      {/* Main Content Layout Grid */}
      <div className="main-content-panel">

        {/* Dynamic Header (Screen & Actions) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '8px' }}>
          <div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)', letterSpacing: '-0.3px' }}>{activeTab}</h2>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              System Status:{' '}
              <strong
                style={{
                  color: chaosActive ? 'var(--color-error)' : 'var(--color-success)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  verticalAlign: 'middle'
                }}
              >
                {chaosActive ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '12px', height: '12px', flexShrink: 0 }}>
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>ANOMALY DETECTED</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ width: '11px', height: '11px', flexShrink: 0 }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>HEALTHY</span>
                  </>
                )}
              </strong>
              <span
                className={`api-status-pill ${apiStatus.state}`}
                title={apiStatus.message}
              >
                {apiStatus.state === 'connected' ? 'API LIVE' : apiStatus.state === 'loading' ? 'API LOADING' : 'API OFFLINE'}
              </span>
              {systemStatus && (
                <button
                  className="api-status-pill connected"
                  onClick={() => handleNavClick('Evidence')}
                  title="Open feature truth and release evidence"
                  style={{ cursor: 'pointer', border: 0 }}
                >
                  {systemStatus.readinessScore}/100 READY
                </button>
              )}
            </span>
          </div>

          <div className="top-actions">
            <button
              className="action-btn-circle"
              style={{
                background: chaosActive ? 'var(--color-error)' : 'var(--bg-card)',
                color: chaosActive ? '#FFF' : 'var(--color-warning)',
                borderColor: chaosActive ? 'var(--color-error)' : 'var(--border-color)',
                animation: chaosActive ? 'pulse 1s infinite alternate' : 'none'
              }}
              title={chaosActive ? "Disable local anomaly marker" : "Enable local anomaly marker"}
              onClick={toggleChaosMode}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '16px', height: '16px', fill: chaosActive ? 'currentColor' : 'none' }}>
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
            <button
              className="action-btn-circle"
              style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', borderColor: 'var(--border-color)' }}
              title="Search Commands (Ctrl+K)"
              onClick={() => { playAudioCue('click'); setCmdPaletteOpen(true); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '15px', height: '15px' }}>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
            <button
              className="action-btn-circle"
              style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', borderColor: 'var(--border-color)' }}
              onClick={() => addToast('No unread system alerts in queue.', 'success')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '15px', height: '15px' }}>
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="notification-badge"></span>
            </button>
          </div>
        </div>

        <div className="operator-workflow-rail" aria-label="NeuralOps operator workflow">
          <div className="workflow-rail-copy">
            <span className="metric-label">Operator Workflow</span>
            <strong>{'Ingest -> Test -> Gate -> Monitor -> Investigate'}</strong>
          </div>
          <div className="workflow-stage-list">
            {workflowStages.map((stage) => (
              <button
                key={stage.label}
                className={`workflow-stage-button ${activeTab === stage.tab ? 'active' : ''}`}
                onClick={() => handleNavClick(stage.tab)}
              >
                <span>{stage.label}</span>
                <small>{stage.detail}</small>
              </button>
            ))}
          </div>
        </div>

        {renderActiveScreen()}
      </div>

      {/* Toast notifications portal */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item ${toast.type}`}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {toast.type === 'success' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="3" style={{ width: '14px', height: '14px' }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : toast.type === 'error' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="2.5" style={{ width: '14px', height: '14px' }}>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2.5" style={{ width: '14px', height: '14px' }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              )}
            </span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

      {/* Command Palette Modal */}
      {cmdPaletteOpen && (
        <div className="cmd-palette-backdrop" onClick={() => setCmdPaletteOpen(false)}>
          <div className="cmd-palette-box" onClick={(e) => e.stopPropagation()}>
            <div className="cmd-input-row">
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: '15px', height: '15px' }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                type="text"
                placeholder="Search screens, model traces, sessions..."
                className="cmd-search-input"
                value={cmdSearch}
                onChange={(e) => setCmdSearch(e.target.value)}
                autoFocus
              />
              <span className="cmd-kbd">ESC</span>
            </div>

            <div className="cmd-results-list">
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text-secondary)', padding: '4px 8px', display: 'block', textTransform: 'uppercase' }}>
                Navigation Actions
              </span>
              {filteredCommands.map((tab) => (
                <div
                  key={tab}
                  className="cmd-item"
                  onClick={() => handleNavClick(tab)}
                >
                  <span>Go to: {tab}</span>
                  <span className="cmd-kbd">Enter</span>
                </div>
              ))}

              {/* Deep Traces results list */}
              {cmdSearch !== '' && traces.filter(t =>
                t.id.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                t.model.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                t.session.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                t.prompt.toLowerCase().includes(cmdSearch.toLowerCase())
              ).length > 0 && (
                <>
                  <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text-secondary)', padding: '12px 8px 4px 8px', display: 'block', textTransform: 'uppercase' }}>
                    Matching Traces (Deep Links)
                  </span>
                  {traces.filter(t =>
                    t.id.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                    t.model.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                    t.session.toLowerCase().includes(cmdSearch.toLowerCase()) ||
                    t.prompt.toLowerCase().includes(cmdSearch.toLowerCase())
                  ).map((trace) => (
                    <div
                      key={trace.id}
                      className="cmd-item"
                      onClick={() => {
                        handleNavClick('Traces');
                        setSelectedTrace(trace);
                        setDrawerOpen(true);
                        addToast(`Deep link: opened trace drawer for ${trace.id}`, 'success');
                      }}
                    >
                      <span>Trace: {trace.id} ({trace.model})</span>
                      <span className="cmd-kbd">Open</span>
                    </div>
                  ))}
                </>
              )}

              {filteredCommands.length === 0 && cmdSearch === '' && (
                <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  No matching screens found
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
