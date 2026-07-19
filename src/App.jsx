import { Suspense, lazy, useEffect, useMemo, useCallback, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import './index.css';
import { ApiError, fetchDashboard, fetchOnboardingStatus, fetchSystemStatus, isRetryableApiError, setApiAuthToken, setApiWorkspaceId, setQaAuthToken } from './lib/api';
import { AUTH_ENABLED, supabase } from './lib/supabase';

// Import Screens
import LandingPage from './components/LandingPage';

const configuredWarmingTimeout = Number(import.meta.env.VITE_API_WARMING_TIMEOUT_MS || 90_000);
const API_WARMING_TIMEOUT_MS = Number.isFinite(configuredWarmingTimeout)
  ? Math.min(90_000, Math.max(1_000, configuredWarmingTimeout))
  : 90_000;

const Overview = lazy(() => import('./components/Overview'));
const ActionCenter = lazy(() => import('./components/ActionCenter'));
const EstateCenter = lazy(() => import('./components/EstateCenter'));
const TraceExplorer = lazy(() => import('./components/TraceExplorer'));
const PromptRegistry = lazy(() => import('./components/PromptRegistry'));
const EvalCenter = lazy(() => import('./components/EvalCenter'));
const RAGQuality = lazy(() => import('./components/RAGQuality'));
const CostDashboard = lazy(() => import('./components/CostDashboard'));
const PolicyManager = lazy(() => import('./components/PolicyManager'));
const IncidentTimeline = lazy(() => import('./components/IncidentTimeline'));
const Agents = lazy(() => import('./components/Agents'));
const NeuralLabs = lazy(() => import('./components/NeuralLabs'));
const ConnectCenter = lazy(() => import('./components/ConnectCenter'));
const GatewayCenter = lazy(() => import('./components/GatewayCenter'));
const SloCenter = lazy(() => import('./components/SloCenter'));
const RiskRegister = lazy(() => import('./components/RiskRegister'));
const ControlCenter = lazy(() => import('./components/ControlCenter'));
const EvidenceCenter = lazy(() => import('./components/EvidenceCenter'));
const AutomationCenter = lazy(() => import('./components/AutomationCenter'));
const AccessCenter = lazy(() => import('./components/AccessCenter'));
const ReleaseAutopilot = lazy(() => import('./components/ReleaseAutopilot'));
const DetectionResponse = lazy(() => import('./components/DetectionResponse'));
const Settings = lazy(() => import('./components/Settings'));
const ProductionReadiness = lazy(() => import('./components/ProductionReadiness'));

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
    case 'Action Center':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16v5H4z" />
          <path d="M4 15h6v5H4z" />
          <path d="M14 15h6v5h-6z" />
          <path d="M7 12h10" />
          <path d="m15 10 2 2-2 2" />
        </svg>
      );
    case 'Estate':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="7" r="3" />
          <circle cx="18" cy="7" r="3" />
          <circle cx="12" cy="18" r="3" />
          <path d="M8.5 9.5 11 15" />
          <path d="m15.5 9.5-2.5 5.5" />
          <path d="M9 7h6" />
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
    case 'SLOs':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="m7 15 3-3 3 2 5-7" />
          <path d="M18 7h2v2" />
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
    case 'Gateway':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h5" />
          <path d="M16 12h5" />
          <path d="M8 12a4 4 0 0 1 8 0" />
          <path d="M8 12a4 4 0 0 0 8 0" />
          <path d="M12 4v4" />
          <path d="M12 16v4" />
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
    case 'Access':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          <path d="m17 11 2 2 4-4" />
        </svg>
      );
    case 'Readiness':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
          <path d="M21 12a9 9 0 1 1-3.4-7" />
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
    case 'Detection':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M8.5 12.5 11 15l5-6" />
          <path d="M7 19 4 22" />
          <path d="m17 19 3 3" />
        </svg>
      );
    case 'Risk Register':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z" />
          <path d="M9 12h6" />
          <path d="M12 9v6" />
        </svg>
      );
    case 'Control Center':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16v16H4z" />
          <path d="M8 8h8" />
          <path d="M8 12h3" />
          <path d="M14 12h2" />
          <path d="M8 16h5" />
          <path d="m15 16 1 1 2-3" />
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
  { label: 'Connect', tab: 'Connect', detail: 'SDK and ingest' },
  { label: 'Route', tab: 'Gateway', detail: 'Policy gateway' },
  { label: 'Test', tab: 'Labs', detail: 'Evals and replay' },
  { label: 'Gate', tab: 'Evidence', detail: 'Release proof' },
  { label: 'Monitor', tab: 'Dashboard', detail: 'Live operations' },
  { label: 'Respond', tab: 'Detection', detail: 'Incidents and actions' },
];

const navGroups = [
  {
    title: 'Home',
    caption: 'Command queue and readiness',
    items: ['Action Center', 'Dashboard', 'Readiness'],
  },
  {
    title: 'Connect',
    caption: 'SDK, gateway, providers',
    items: ['Connect', 'Gateway'],
  },
  {
    title: 'Observe',
    caption: 'Systems, traces, incidents, cost',
    items: ['Estate', 'Traces', 'Incidents', 'Cost'],
  },
  {
    title: 'Test & Release',
    caption: 'Prompts, RAG, agents, replay',
    items: ['Prompts', 'Evaluations', 'RAG Quality', 'Labs', 'Agents', 'Autopilot'],
  },
  {
    title: 'Govern',
    caption: 'Policy, SLOs, risk, proof',
    items: ['Policies', 'SLOs', 'Risk Register', 'Control Center', 'Evidence', 'Detection', 'Automations'],
  },
  {
    title: 'Admin',
    caption: 'Access and configuration',
    items: ['Access', 'Settings'],
  },
];

const routeByTab = {
  'Action Center': '/',
  Dashboard: '/home/dashboard',
  Readiness: '/admin/readiness',
  Connect: '/connect',
  Gateway: '/gateway',
  Estate: '/observe/estate',
  Traces: '/observe/traces',
  Incidents: '/observe/incidents',
  Cost: '/observe/cost',
  Prompts: '/release/prompts',
  Evaluations: '/release/evaluations',
  'RAG Quality': '/release/rag-quality',
  Labs: '/release/replay-gate',
  Agents: '/release/agents',
  Autopilot: '/release/autopilot',
  Policies: '/govern/policies',
  SLOs: '/govern/slos',
  'Risk Register': '/govern/risk-register',
  'Control Center': '/govern/control-center',
  Evidence: '/govern/evidence',
  Detection: '/govern/detection',
  Automations: '/govern/automations',
  Access: '/admin/access',
  Settings: '/admin/settings',
};

const tabByRoute = Object.entries(routeByTab)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([tab, path]) => ({ tab, path }));

const navigateTab = (navigate, tab, options = {}) => {
  const path = routeByTab[tab] || routeByTab.Dashboard;
  navigate(path, options);
};

const activeTabFromPath = (pathname) => {
  const match = tabByRoute.find(({ path }) => pathname === path || (path !== '/' && pathname.startsWith(`${path}/`)));
  return match?.tab || 'Action Center';
};

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppRoutes(props) {
  return (
    <Routes>
      <Route path="/" element={<ActionCenter addToast={props.addToast} setActiveTab={props.setActiveTab} />} />
      <Route path="/home/dashboard" element={<DashboardRoute {...props} />} />
      <Route path="/connect" element={<ConnectCenter addToast={props.addToast} refreshDashboard={props.refreshDashboard} />} />
      <Route path="/gateway" element={<GatewayCenter addToast={props.addToast} />} />
      <Route path="/observe/estate" element={<EstateCenter addToast={props.addToast} setActiveTab={props.setActiveTab} />} />
      <Route path="/observe/traces" element={<TraceRoute {...props} />} />
      <Route path="/observe/traces/:traceId" element={<TraceRoute {...props} />} />
      <Route path="/observe/incidents" element={<IncidentTimeline incidents={props.incidents} setIncidents={props.setIncidents} addToast={props.addToast} />} />
      <Route path="/observe/cost" element={<CostDashboard addToast={props.addToast} />} />
      <Route path="/release/prompts" element={<PromptRegistry addToast={props.addToast} />} />
      <Route path="/release/evaluations" element={<EvalCenter addToast={props.addToast} />} />
      <Route path="/release/rag-quality" element={<RAGQuality addToast={props.addToast} />} />
      <Route path="/release/replay-gate" element={<NeuralLabs addToast={props.addToast} refreshDashboard={props.refreshDashboard} />} />
      <Route path="/release/agents" element={<Agents addToast={props.addToast} onTraceCreated={props.handleTraceCreated} />} />
      <Route path="/release/autopilot" element={<ReleaseAutopilot addToast={props.addToast} />} />
      <Route path="/govern/policies" element={<PolicyManager addToast={props.addToast} />} />
      <Route path="/govern/slos" element={<SloCenter addToast={props.addToast} />} />
      <Route path="/govern/risk-register" element={<RiskRegister addToast={props.addToast} />} />
      <Route path="/govern/control-center" element={<ControlCenter addToast={props.addToast} />} />
      <Route path="/govern/evidence" element={<EvidenceCenter addToast={props.addToast} />} />
      <Route path="/govern/detection" element={<DetectionResponse addToast={props.addToast} refreshDashboard={props.refreshDashboard} />} />
      <Route path="/govern/automations" element={<AutomationCenter addToast={props.addToast} />} />
      <Route path="/admin/access" element={<AccessCenter addToast={props.addToast} />} />
      <Route path="/admin/readiness" element={<ProductionReadiness addToast={props.addToast} />} />
      <Route path="/admin/settings" element={<Settings addToast={props.addToast} onNavigate={props.handleNavClick} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function DashboardRoute(props) {
  return (
    <Overview
      stats={props.stats}
      traces={props.traces}
      incidents={props.incidents}
      systemStatus={props.systemStatus}
      apiStatus={props.apiStatus}
      setActiveTab={props.setActiveTab}
      setSelectedTrace={props.setSelectedTrace}
      setDrawerOpen={props.setDrawerOpen}
      timerActive={props.timerActive}
      setTimerActive={props.setTimerActive}
      timerSeconds={props.timerSeconds}
      formatTime={props.formatTime}
    />
  );
}

function TraceRoute(props) {
  const { traceId } = useParams();
  const {
    traces,
    selectedTrace,
    setSelectedTrace,
    drawerOpen,
    setDrawerOpen,
  } = props;

  useEffect(() => {
    if (!traceId || traces.length === 0) return;
    const trace = traces.find((item) => item.id === traceId);
    if (!trace) return;
    setSelectedTrace(trace);
    setDrawerOpen(true);
  }, [traceId, traces, setSelectedTrace, setDrawerOpen]);

  return (
    <TraceExplorer
      traces={traces}
      selectedTrace={selectedTrace}
      setSelectedTrace={setSelectedTrace}
      drawerOpen={drawerOpen}
      setDrawerOpen={setDrawerOpen}
      onTraceOpen={(trace) => {
        if (trace?.id) {
          props.navigate(`/observe/traces/${trace.id}`);
        }
      }}
    />
  );
}

function ScreenLoading({ activeTab }) {
  return (
    <div className="screen-loading-card" role="status" aria-live="polite">
      <span className="badge badge-warning">Loading workflow</span>
      <strong>{activeTab}</strong>
      <p>Loading this enterprise surface as a separate route chunk.</p>
    </div>
  );
}

function appDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function withAppTimeout(promise, milliseconds) {
  if (!milliseconds || milliseconds <= 0) return promise;
  return Promise.race([
    promise,
    appDelay(milliseconds).then(() => {
      throw new TypeError('Backend readiness check timed out');
    }),
  ]);
}

function WorkspaceLaunchChecklist({ systemStatus, onboardingTruth, traces, apiStatus, session, onNavigate }) {
  const featureById = useMemo(() => {
    return new Map((systemStatus?.features || []).map((feature) => [feature.id, feature]));
  }, [systemStatus]);
  const hasState = (id, accepted = ['persisted', 'live_provider']) => accepted.includes(featureById.get(id)?.state);
  const routeForProofStep = {
    workspace: 'Access',
    database: 'Readiness',
    auth: 'Access',
    ingest_key: 'Connect',
    first_trace: 'Traces',
    provider: 'Settings',
    gateway: 'Gateway',
    policy_proof: 'Connect',
    release_gate: 'Evidence',
    evidence: 'Evidence',
  };
  const proofLoopSteps = (onboardingTruth?.steps || []).map((step) => ({
    label: step.label,
    tab: routeForProofStep[step.id] || 'Connect',
    status: step.state === 'complete' ? 'complete' : 'not_configured',
    evidence: step.detail,
    action: step.state === 'complete' ? 'Review evidence' : 'Complete step',
  }));
  const fallbackSteps = [
    {
      label: 'Workspace',
      tab: 'Access',
      status: systemStatus?.authRequired ? (session ? 'complete' : 'blocked') : 'complete',
      evidence: systemStatus?.authRequired ? 'Supabase auth is required for this workspace.' : 'Local development workspace is active.',
      action: 'Review access',
    },
    {
      label: 'Ingest key',
      tab: 'Connect',
      status: hasState('trace_ingest') || hasState('connect_sdk') ? 'complete' : 'not_configured',
      evidence: featureById.get('trace_ingest')?.evidence || 'No ingest key evidence loaded yet.',
      action: 'Open Connect',
    },
    {
      label: 'First trace',
      tab: 'Traces',
      status: traces.length > 0 ? 'complete' : 'not_configured',
      evidence: `${traces.length} trace record(s) currently loaded from backend.`,
      action: 'Open Traces',
    },
    {
      label: 'Provider gateway',
      tab: 'Gateway',
      status: hasState('policy_gateway') ? 'complete' : featureById.get('policy_gateway')?.state === 'live_provider' ? 'complete' : 'not_configured',
      evidence: featureById.get('policy_gateway')?.evidence || 'Gateway readiness has not been verified.',
      action: 'Open Gateway',
    },
    {
      label: 'Release proof',
      tab: 'Evidence',
      status: hasState('release_gates') ? 'complete' : 'not_configured',
      evidence: featureById.get('release_gates')?.evidence || 'No release gate run has been recorded.',
      action: 'Open Evidence',
    },
    {
      label: 'Evidence export',
      tab: 'Control Center',
      status: hasState('risk_register') || hasState('ai_slos') ? 'complete' : 'not_configured',
      evidence: 'Control Center exports the cross-workflow evidence matrix.',
      action: 'Open Controls',
    },
  ];
  const launchSteps = proofLoopSteps.length ? proofLoopSteps : fallbackSteps;
  const mode = systemStatus?.environment || (apiStatus.state === 'ready' ? 'local' : apiStatus.state);
  const configured = launchSteps.filter((step) => step.status === 'complete').length;

  return (
    <section className="operator-launch-board workspace-launch-checklist" aria-label="Workspace launch checklist">
      <div className="launch-board-copy">
        <div className="launch-board-status-row">
          <span className={`badge ${apiStatus.state === 'ready' ? 'badge-success' : 'badge-warning'}`}>
            Data mode: {mode}
          </span>
          <span className="badge badge-success">{configured}/{launchSteps.length} launch steps ready</span>
          {systemStatus?.storage && <span className="badge badge-warning">Storage: {systemStatus.storage}</span>}
          {onboardingTruth?.schemaVersion && <span className="badge badge-success">Proof loop live</span>}
        </div>
        <h3>Workspace Launch Checklist</h3>
        <p>
          NeuralOps should prove each step from connection to production evidence. These cards are derived from backend feature truth,
          not static UI claims.
        </p>
      </div>
      <div className="launch-step-grid">
        {launchSteps.map((step) => (
          <button
            className={`launch-step-card launch-step-${step.status}`}
            key={step.label}
            onClick={() => onNavigate(step.tab)}
          >
            <span className={`badge ${step.status === 'complete' ? 'badge-success' : step.status === 'blocked' ? 'badge-error' : 'badge-warning'}`}>
              {step.status === 'complete' ? 'Complete' : step.status === 'blocked' ? 'Blocked' : 'Not configured'}
            </span>
            <strong>{step.label}</strong>
            <p>{step.evidence}</p>
            <span>{step.action}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('neuralops-theme') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('neuralops-theme', theme);
  }, [theme]);

  const [selectedTrace, setSelectedTrace] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdSearch, setCmdSearch] = useState('');
  const [toasts, setToasts] = useState([]);
  const [apiStatus, setApiStatus] = useState({ state: 'checking', message: 'Checking the NeuralOps backend...' });
  const [systemStatus, setSystemStatus] = useState(null);
  const [onboardingTruth, setOnboardingTruth] = useState(null);
  const [session, setSession] = useState(null);

  useEffect(() => {
    if (!AUTH_ENABLED || !supabase) return undefined;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) {
        setSession(data.session);
        setApiAuthToken(data.session.access_token);
        setQaAuthToken(null);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setApiAuthToken(nextSession?.access_token || null);
      setQaAuthToken(null);
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

  const signedInEmail = session?.user?.email || 'Authenticated operator';
  const activeTab = activeTabFromPath(location.pathname);
  const setActiveTab = useCallback((tab) => navigateTab(navigate, tab), [navigate]);

  const loadBootstrap = useCallback(async ({ retryForMs = 0, isCancelled = () => false } = {}) => {
    const startedAt = Date.now();
    const backoff = [1000, 2000, 4000, 8000, 12000];
    let attempt = 0;
    setApiStatus({ state: 'checking', message: 'Checking the NeuralOps backend...' });

    while (!isCancelled()) {
      try {
        const remainingWindow = retryForMs > 0 ? Math.max(1, retryForMs - (Date.now() - startedAt)) : 0;
        const [snapshot, status, proofStatus] = await withAppTimeout(
          Promise.all([
            fetchDashboard(),
            fetchSystemStatus(),
            fetchOnboardingStatus().catch((error) => {
              if (error instanceof ApiError && error.status === 404) return null;
              throw error;
            }),
          ]),
          retryForMs > 0 ? Math.min(15000, remainingWindow) : 0,
        );
        if (isCancelled()) return false;
        setStats(snapshot.stats);
        setTraces(snapshot.traces);
        setIncidents(snapshot.incidents);
        setSystemStatus(status);
        setOnboardingTruth(proofStatus);
        setApiStatus({ state: 'ready', message: 'Live backend data store connected' });
        return true;
      } catch (error) {
        if (isCancelled()) return false;
        const elapsed = Date.now() - startedAt;
        if (retryForMs === 0 || elapsed >= retryForMs || !isRetryableApiError(error)) {
          const message = error instanceof ApiError && [401, 403].includes(error.status)
            ? 'Backend access denied. Sign in again or verify workspace access.'
            : 'Backend unavailable. No local sample data is being shown.';
          setApiStatus({ state: 'unavailable', message });
          return false;
        }
        setApiStatus({
          state: 'warming',
          message: `Backend is warming. Retrying the same safe bootstrap read for up to ${Math.round(retryForMs / 1000)} seconds.`,
        });
        const remaining = retryForMs - elapsed;
        await appDelay(Math.min(backoff[Math.min(attempt, backoff.length - 1)], remaining));
        attempt += 1;
      }
    }
    return false;
  }, []);

  useEffect(() => {
    if (AUTH_ENABLED && !session) return undefined;
    let cancelled = false;
    const loadTimer = window.setTimeout(() => {
      void loadBootstrap({ retryForMs: API_WARMING_TIMEOUT_MS, isCancelled: () => cancelled });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
    };
  }, [loadBootstrap, session]);

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

  const handleSignOut = async () => {
    playAudioCue('click');
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) {
        addToast(`Sign out failed: ${error.message}`, 'error');
        return;
      }
    }
    setSession(null);
    setApiAuthToken(null);
    setApiWorkspaceId(null);
    setQaAuthToken(null);
    setSystemStatus(null);
    setOnboardingTruth(null);
    setTraces([]);
    setIncidents([]);
    setStats({
      totalRequests: 0,
      avgLatency: '0.00s',
      p95Latency: '0.00s',
      errorRate: '0.0%',
      totalCost: '$0.000',
      evalPassRate: '0.0%',
      policyViolations: 0,
      activeIncidents: 0
    });
  };

  // Local visual anomaly marker for operator drills; it never mutates backend records.
  const [chaosActive, setChaosActive] = useState(false);

  const refreshDashboard = useCallback(() => {
    void loadBootstrap({ retryForMs: API_WARMING_TIMEOUT_MS });
  }, [loadBootstrap]);

  const handleTraceCreated = useCallback((trace) => {
    if (!trace?.id) return;
    setTraces((current) => [trace, ...current.filter((item) => item.id !== trace.id)]);
  }, []);

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
  const formatTime = useCallback((secs) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  }, []);

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
  const handleNavClick = useCallback((tab) => {
    setActiveTab(tab);
    setCmdPaletteOpen(false);
  }, [setActiveTab]);

  const navItems = Array.from(new Set(navGroups.flatMap((group) => group.items)));

  const screenProps = useMemo(() => ({
    addToast,
    navigate,
    setActiveTab,
    stats,
    traces,
    incidents,
    systemStatus,
    apiStatus,
    setSelectedTrace,
    selectedTrace,
    drawerOpen,
    setDrawerOpen,
    setIncidents,
    timerActive,
    setTimerActive,
    timerSeconds,
    formatTime,
    handleTraceCreated,
    refreshDashboard,
    handleNavClick,
  }), [
    addToast,
    navigate,
    setActiveTab,
    stats,
    traces,
    incidents,
    systemStatus,
    apiStatus,
    selectedTrace,
    drawerOpen,
    timerActive,
    timerSeconds,
    formatTime,
    handleTraceCreated,
    refreshDashboard,
    handleNavClick,
  ]);

  // Command palette search filtering
  const filteredCommands = navItems.filter(cmd =>
    cmd.toLowerCase().includes(cmdSearch.toLowerCase())
  );

  if (AUTH_ENABLED && !session) {
    return <LandingPage onSession={(nextSession) => {
      setSession(nextSession);
      setApiAuthToken(nextSession?.access_token || null);
      setQaAuthToken(nextSession?.qa_token || null);
    }} />;
  }

  return (
    <div className="dashboard-wrapper">
      {/* Left Sidebar Panel */}
      <aside className="sidebar-container">
        {/* NeuralOps boundary-gate brand mark */}
        <button className="sidebar-logo" onClick={() => handleNavClick('Dashboard')}>
          <span className="sidebar-boundary-mark" aria-hidden="true"><i /><i /></span>
          NeuralOps
        </button>

        {/* Sidebar Navigation Items */}
        <div className="sidebar-nav-list" aria-label="Primary navigation">
          {navGroups.map((group) => (
            <section className="sidebar-nav-section" key={group.title} aria-label={group.title}>
              <div className="sidebar-nav-section-title">
                <span>{group.title}</span>
                <small>{group.caption}</small>
              </div>
              {group.items.map((tab) => (
                <button
                  key={tab}
                  className={`sidebar-nav-item ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => handleNavClick(tab)}
                >
                  {getNavIcon(tab)}
                  {tab}
                </button>
              ))}
            </section>
          ))}
        </div>

        {/* Backend-derived workspace summary */}
        <div className="sidebar-meta-card">
          <div style={{ display: 'grid', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>API</span>
              <span className={`badge ${apiStatus.state === 'ready' ? 'badge-success' : ['checking', 'warming'].includes(apiStatus.state) ? 'badge-warning' : 'badge-error'}`} style={{ fontSize: '8px' }}>
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
        <div className="sidebar-profile">
          <div className="avatar-circle" style={{ width: '36px', height: '36px' }}>
            <div className="avatar-initials" aria-label="NeuralOps operator avatar">NO</div>
          </div>
          <button className="sidebar-profile-info sidebar-profile-button" onClick={() => handleNavClick('Settings')}>
            <span className="sidebar-profile-name">{signedInEmail}</span>
            <span className="sidebar-profile-role">{apiStatus.state === 'ready' ? 'Backend connected' : apiStatus.state === 'warming' ? 'Backend warming' : apiStatus.state === 'checking' ? 'Checking backend' : 'Backend unavailable'}</span>
          </button>
          <button className="sidebar-profile-badge sidebar-signout-button" onClick={handleSignOut}>
            Sign out
          </button>
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
                {apiStatus.state === 'ready' ? 'API LIVE' : apiStatus.state === 'warming' ? 'API WARMING' : apiStatus.state === 'checking' ? 'API CHECKING' : 'API UNAVAILABLE'}
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
              aria-label="Notifications"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '15px', height: '15px' }}>
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="notification-badge"></span>
            </button>
            <button
              className="action-btn-circle"
              style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', borderColor: 'var(--border-color)' }}
              title="Sign out"
              aria-label="Sign out"
              onClick={handleSignOut}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '16px', height: '16px' }}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="operator-workflow-rail" aria-label="NeuralOps operator workflow">
          <div className="workflow-rail-copy">
            <span className="metric-label">Operator Workflow</span>
            <strong>{'Connect -> Route -> Test -> Gate -> Monitor -> Respond'}</strong>
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

        <Suspense fallback={<ScreenLoading activeTab={activeTab} />}>
          <AppRoutes {...screenProps} />
        </Suspense>

        <WorkspaceLaunchChecklist
          systemStatus={systemStatus}
          onboardingTruth={onboardingTruth}
          traces={traces}
          apiStatus={apiStatus}
          session={session}
          onNavigate={handleNavClick}
        />
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
                        navigate(`/observe/traces/${trace.id}`);
                        setCmdPaletteOpen(false);
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
