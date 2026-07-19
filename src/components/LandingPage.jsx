import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  Check,
  Fingerprint,
  Key,
  LockKey,
  ShieldCheck,
  TerminalWindow,
  X,
} from '@phosphor-icons/react';
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from 'motion/react';
import AuthGate from './AuthGate';
import { submitPilotApplication } from '../lib/api';
import '../landing.css';

const EMPTY_APPLICATION = {
  name: '',
  workEmail: '',
  company: '',
  role: '',
  teamSize: '1-5',
  expectedAgents: '3',
  primaryUseCase: '',
  consent: false,
  website: '',
};

const plans = [
  {
    name: 'Developer',
    price: '$0',
    cadence: 'during pilot',
    description: 'For one builder proving the authorization loop before involving a wider team.',
    features: ['Agent identity registry', 'Metadata-only telemetry', 'Local and staging workflows', 'Approval evidence trail'],
  },
  {
    name: 'Team',
    price: '$149',
    cadence: '/ month',
    description: 'For a product team supervising agents that use real tools and providers.',
    features: ['Shared approval queue', 'Credential rotation and revocation', 'Emergency stop', 'Evidence exports'],
    featured: true,
  },
  {
    name: 'Business',
    price: '$499',
    cadence: '/ month',
    description: 'For multiple teams operating governed agents across production boundaries.',
    features: ['Production access decisions', 'Retention policies', 'Legal holds', 'Priority pilot onboarding'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'scoped with you',
    description: 'For organizations that need documented security and deployment review.',
    features: ['Architecture review', 'Security review', 'Deployment planning', 'Commercial terms'],
  },
];

const proofItems = [
  {
    id: 'command',
    kicker: 'Command posture',
    title: 'Know what can act before it acts.',
    body: 'See workspace health, agent ownership, connected systems, and enforcement readiness in one operational surface.',
    image: '/media/product-connectivity.webp',
    alt: 'Sanitized NeuralOps Action Center in a local demonstration workspace.',
  },
  {
    id: 'control',
    kicker: 'Authorization evidence',
    title: 'Require a decision at the tool boundary.',
    body: 'High-risk actions wait for current approval. Revoked identities, expired leases, and unavailable policy checks fail closed.',
    image: '/media/product-agent-control.webp',
    alt: 'Sanitized NeuralOps Agent Command Center in a local demonstration workspace.',
  },
  {
    id: 'evidence',
    kicker: 'Release proof',
    title: 'Carry the decision into the audit trail.',
    body: 'Every allowed, blocked, and revoked action produces workspace-scoped evidence without storing the sensitive content itself.',
    image: '/media/product-evidence.webp',
    alt: 'Sanitized NeuralOps evidence and release gate in a local demonstration workspace.',
  },
];

const captured = [
  'Agent, action, and tool category IDs',
  'Timing, provider, model, tokens, and cost totals',
  'Status, policy findings, and content hashes',
  'Approval actors, reasons, expiry, and evidence',
];

const excluded = [
  'Raw prompts or model outputs',
  'Tool arguments, provider keys, or secrets',
  'Uploaded files or browser content',
  'Agent credentials after one-time issuance',
];

const reveal = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0 },
};

export default function LandingPage({ onSession }) {
  const [authOpen, setAuthOpen] = useState(false);
  const [application, setApplication] = useState(EMPTY_APPLICATION);
  const [submission, setSubmission] = useState({ state: 'idle', message: '' });
  const idempotencyKey = useRef(createPilotKey());
  const authTrigger = useRef(null);
  const reduceMotion = useReducedMotion();

  const openAuth = (event) => {
    authTrigger.current = event.currentTarget;
    setAuthOpen(true);
  };

  const closeAuth = () => {
    setAuthOpen(false);
    window.requestAnimationFrame(() => authTrigger.current?.focus());
  };

  const handlePilotSubmit = async (event) => {
    event.preventDefault();
    setSubmission({ state: 'submitting', message: 'Contacting NeuralOps. Your application remains unchanged while the backend wakes.' });
    try {
      const receipt = await submitPilotApplication({
        ...application,
        role: application.role.trim() || null,
        expectedAgents: Number(application.expectedAgents),
      }, idempotencyKey.current);
      setSubmission({
        state: 'received',
        message: `Application received. Reference ${receipt.applicationId}. We will review fit before issuing an invitation.`,
      });
      setApplication(EMPTY_APPLICATION);
      idempotencyKey.current = createPilotKey();
    } catch (error) {
      setSubmission({ state: 'error', message: `Application was not submitted: ${readableError(error)}` });
    }
  };

  return (
    <div className="landing">
      <a className="landing__skip" href="#main">Skip to content</a>
      <header className="landing__nav">
        <a className="landing__brand" href="#top" aria-label="NeuralOps home">
          <BoundaryMark />
          <span>NeuralOps</span>
        </a>
        <nav aria-label="Public navigation">
          <a href="#how-it-works">Control model</a>
          <a href="#privacy">Privacy</a>
          <a href="#pricing">Pricing</a>
          <button type="button" onClick={openAuth}>Sign in</button>
        </nav>
      </header>

      <main id="main">
        <section className="landing__hero" id="top">
          <motion.div
            className="landing__hero-copy"
            initial={false}
          >
            <motion.span className="landing__eyebrow">Runtime authorization for AI agents</motion.span>
            <motion.h1>Stop unsafe agent actions before they happen.</motion.h1>
            <motion.p>Identity-bound authorization and human approval before high-risk tools touch production.</motion.p>
            <motion.div className="landing__hero-actions">
              <a className="landing__cta" href="#pilot">Request pilot access <ArrowDownRight weight="bold" /></a>
              <a className="landing__text-link" href="#how-it-works">See the control path <ArrowRight /></a>
            </motion.div>
          </motion.div>

          <AuthorizationCanvas reduceMotion={reduceMotion} />
        </section>

        <aside className="landing__cold-start" aria-label="Pilot infrastructure disclosure">
          <div><ShieldCheck weight="fill" /><strong>Honest pilot infrastructure</strong></div>
          <p>The free-tier backend may need up to 90 seconds to wake. NeuralOps preserves the intended action with an idempotency key and never reports success before backend confirmation.</p>
        </aside>

        <AuthorizationPath reduceMotion={reduceMotion} />
        <ProductProof reduceMotion={reduceMotion} />

        <section className="landing__privacy" id="privacy" aria-labelledby="privacy-heading">
          <motion.div className="landing__privacy-intro" initial={reduceMotion ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: 0.35 }} variants={reveal}>
            <span className="landing__eyebrow">Privacy boundary</span>
            <h2 id="privacy-heading">Metadata in.<br />Sensitive content out.</h2>
            <p>NeuralOps proves what happened without becoming another store of prompts, secrets, files, and provider credentials.</p>
          </motion.div>
          <div className="landing__privacy-ledger">
            <PrivacyList title="Captured by default" items={captured} included reduceMotion={reduceMotion} />
            <PrivacyList title="Outside the boundary" items={excluded} reduceMotion={reduceMotion} />
          </div>
        </section>

        <section className="landing__pricing" id="pricing" role="region" aria-label="Pricing">
          <motion.div className="landing__section-heading" initial={reduceMotion ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: 0.4 }} variants={reveal}>
            <h2>Start with control. Pay when the team depends on it.</h2>
            <p>Billing activates only after pilot acceptance and commercial approval.</p>
          </motion.div>
          <div className="landing__price-rail">
            {plans.map((plan, index) => (
              <motion.article
                className={plan.featured ? 'landing__plan landing__plan--featured' : 'landing__plan'}
                key={plan.name}
                initial={reduceMotion ? false : { opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.45 }}
                transition={{ delay: index * 0.06 }}
              >
                <div className="landing__plan-name"><span>{plan.name}</span>{plan.featured && <b>Recommended pilot</b>}</div>
                <div className="landing__plan-price"><strong>{plan.price}</strong><small>{plan.cadence}</small></div>
                <p>{plan.description}</p>
                <ul>{plan.features.map((feature) => <li key={feature}><Check weight="bold" />{feature}</li>)}</ul>
              </motion.article>
            ))}
          </div>
        </section>

        <section className="landing__pilot" id="pilot" aria-labelledby="pilot-heading">
          <motion.div className="landing__pilot-copy" initial={reduceMotion ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: 0.3 }} variants={reveal}>
            <h2 id="pilot-heading">Bring one real agent workflow.</h2>
            <p>We select teams with a concrete agent, a named owner, and at least one meaningful tool boundary.</p>
            <dl>
              <div><dt>What happens next</dt><dd>We review fit, confirm the workflow, and schedule onboarding if accepted.</dd></div>
              <div><dt>What belongs here</dt><dd>Contact and pilot-scoping metadata only. Never submit prompts, secrets, provider keys, or customer data.</dd></div>
            </dl>
          </motion.div>

          <motion.form className="landing__pilot-form" aria-label="Invited pilot application" onSubmit={handlePilotSubmit} initial={reduceMotion ? false : { opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.2 }}>
            <div className="landing__field-row">
              <label>Name<input value={application.name} onChange={(event) => setApplication({ ...application, name: event.target.value })} required minLength="2" autoComplete="name" /></label>
              <label>Work email<input type="email" value={application.workEmail} onChange={(event) => setApplication({ ...application, workEmail: event.target.value })} required autoComplete="email" /></label>
            </div>
            <div className="landing__field-row">
              <label>Company<input value={application.company} onChange={(event) => setApplication({ ...application, company: event.target.value })} required minLength="2" autoComplete="organization" /></label>
              <label>Role <small>optional</small><input value={application.role} onChange={(event) => setApplication({ ...application, role: event.target.value })} autoComplete="organization-title" /></label>
            </div>
            <div className="landing__field-row">
              <label>Team size<select value={application.teamSize} onChange={(event) => setApplication({ ...application, teamSize: event.target.value })}><option value="1-5">1-5</option><option value="6-20">6-20</option><option value="21-50">21-50</option><option value="51+">51+</option></select></label>
              <label>Expected managed agents<input type="number" min="1" max="10000" value={application.expectedAgents} onChange={(event) => setApplication({ ...application, expectedAgents: event.target.value })} required /></label>
            </div>
            <label>Primary use case<textarea value={application.primaryUseCase} onChange={(event) => setApplication({ ...application, primaryUseCase: event.target.value })} required minLength="12" placeholder="Which agent acts, which tools it uses, and what must require approval?" /></label>
            <label className="landing__consent"><input type="checkbox" checked={application.consent} onChange={(event) => setApplication({ ...application, consent: event.target.checked })} required /><span>I agree to be contacted about the invited NeuralOps pilot and understand this form stores lead metadata.</span></label>
            <label className="landing__honeypot" aria-hidden="true">Website<input value={application.website} onChange={(event) => setApplication({ ...application, website: event.target.value })} tabIndex="-1" autoComplete="off" /></label>
            <button type="submit" disabled={submission.state === 'submitting'}>{submission.state === 'submitting' ? 'Submitting application' : 'Submit pilot application'} <ArrowRight weight="bold" /></button>
            <AnimatePresence mode="wait">
              {submission.message && <motion.p key={submission.state} className={`landing__form-status landing__form-status--${submission.state}`} role={submission.state === 'error' ? 'alert' : 'status'} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{submission.message}</motion.p>}
            </AnimatePresence>
          </motion.form>
        </section>
      </main>

      <footer className="landing__footer">
        <a className="landing__brand" href="#top"><BoundaryMark /><span>NeuralOps</span></a>
        <p>Runtime authority for agents that act.</p>
        <button type="button" onClick={openAuth}>Operator sign in <ArrowRight /></button>
      </footer>

      {authOpen && <AuthDialog onClose={closeAuth} onSession={onSession} reduceMotion={reduceMotion} />}
    </div>
  );
}

function BoundaryMark() {
  return <span className="landing__brand-mark" aria-hidden="true"><i /><i /></span>;
}

function AuthorizationCanvas({ reduceMotion }) {
  const canvasRef = useRef(null);
  const [decision, setDecision] = useState('pending');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    let frame = 0;
    let progress = 0;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, bounds.width);
      const height = Math.max(260, bounds.height);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#0b0b0b';
      context.fillRect(0, 0, width, height);

      const y = height * 0.48;
      const nodes = [
        { x: width * 0.12, label: 'AGENT', value: 'deploy-bot' },
        { x: width * 0.5, label: 'NEURALOPS', value: decision === 'pending' ? 'approval required' : decision },
        { x: width * 0.88, label: 'TOOL', value: 'browser.write' },
      ];
      context.lineWidth = 1;
      context.strokeStyle = '#343434';
      context.beginPath();
      context.moveTo(nodes[0].x + 62, y);
      context.lineTo(nodes[2].x - 62, y);
      context.stroke();

      nodes.forEach((node, index) => {
        const gated = index === 1;
        context.fillStyle = gated ? '#151515' : '#101010';
        context.strokeStyle = gated ? '#ff6547' : '#3a3a3a';
        context.beginPath();
        context.roundRect(node.x - 62, y - 44, 124, 88, 6);
        context.fill();
        context.stroke();
        context.fillStyle = gated ? '#ff8068' : '#858585';
        context.font = '10px "IBM Plex Mono", monospace';
        context.textAlign = 'center';
        context.fillText(node.label, node.x, y - 10);
        context.fillStyle = '#ededed';
        context.font = '12px "Instrument Sans", sans-serif';
        context.fillText(node.value, node.x, y + 14);
      });

      const start = nodes[0].x + 68;
      const gate = nodes[1].x - 68;
      const end = nodes[2].x - 68;
      const destination = decision === 'approved' ? end : gate;
      const packetX = start + (destination - start) * progress;
      context.fillStyle = '#ff6547';
      context.beginPath();
      context.arc(packetX, y, 5, 0, Math.PI * 2);
      context.fill();

      if (decision === 'blocked') {
        context.strokeStyle = '#ff6547';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(gate - 8, y - 10);
        context.lineTo(gate + 8, y + 10);
        context.moveTo(gate + 8, y - 10);
        context.lineTo(gate - 8, y + 10);
        context.stroke();
      }

      if (!reduceMotion && progress < 1) {
        progress = Math.min(1, progress + 0.025);
        frame = window.requestAnimationFrame(draw);
      }
    };

    if (reduceMotion) progress = 1;
    draw();
    const observer = new ResizeObserver(() => {
      progress = reduceMotion ? 1 : progress;
      draw();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [decision, reduceMotion]);

  return (
    <motion.section
      className="landing__auth-canvas"
      aria-labelledby="auth-canvas-title"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.98, x: 18 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      transition={{ duration: 0.65, delay: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <header>
        <div><span>Interactive control path</span><strong id="auth-canvas-title">Production write request</strong></div>
        <b className={`landing__canvas-state landing__canvas-state--${decision}`}>{decision}</b>
      </header>
      <canvas ref={canvasRef} role="img" aria-label={`Authorization path for deploy-bot requesting browser.write. Decision: ${decision}.`} />
      <div className="landing__canvas-request">
        <div><small>Agent</small><strong>deploy-bot</strong></div>
        <div><small>Action</small><strong>browser.write</strong></div>
        <div><small>Risk</small><strong>High</strong></div>
        <div><small>Environment</small><strong>Production</strong></div>
      </div>
      <footer>
        <p>This local simulation does not execute a tool.</p>
        <div>
          <button type="button" onClick={() => setDecision('blocked')} aria-pressed={decision === 'blocked'}>Block</button>
          <button type="button" onClick={() => setDecision('approved')} aria-pressed={decision === 'approved'}>Approve 60s</button>
          {decision !== 'pending' && <button type="button" onClick={() => setDecision('pending')}>Reset</button>}
        </div>
      </footer>
    </motion.section>
  );
}

function AuthorizationPath({ reduceMotion }) {
  const steps = [
    { icon: Fingerprint, title: 'Identity bound', detail: 'Owner, workspace, environment, and permissions verified.' },
    { icon: TerminalWindow, title: 'Action requested', detail: 'browser.write is classified as a high-risk tool action.' },
    { icon: Key, title: 'Approval checked', detail: 'No current approval or active authorization lease exists.' },
    { icon: LockKey, title: 'Execution blocked', detail: 'The tool does not run. Evidence is written to the audit chain.' },
  ];
  return (
    <section className="landing__path" id="how-it-works" aria-labelledby="path-heading">
      <motion.div className="landing__section-heading" initial={reduceMotion ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: 0.35 }} variants={reveal}>
        <h2 id="path-heading">Permission lives in the runtime.</h2>
        <p>Built-in and external agents take the same enforcement path. High-risk actions cannot proceed on stale approval or backend unavailability.</p>
      </motion.div>
      <ol className="landing__path-flow">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <motion.li key={step.title} initial={reduceMotion ? false : { opacity: 0, x: -20 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: 0.7 }} transition={{ delay: index * 0.08 }}>
              <span className="landing__path-icon"><Icon weight={index === steps.length - 1 ? 'fill' : 'regular'} /></span>
              <span className="landing__path-index">0{index + 1}</span>
              <div><h3>{step.title}</h3><p>{step.detail}</p></div>
              <strong>{index === steps.length - 1 ? 'BLOCK' : 'VERIFY'}</strong>
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}

function ProductProof({ reduceMotion }) {
  const containerRef = useRef(null);
  const [activeProof, setActiveProof] = useState(0);
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start center', 'end center'] });

  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    if (reduceMotion) return;
    setActiveProof(Math.min(proofItems.length - 1, Math.floor(value * proofItems.length)));
  });

  return (
    <section className="landing__proof" ref={containerRef} aria-labelledby="proof-heading">
      <div className="landing__proof-sticky">
        <div className="landing__proof-copy">
          <span className="landing__section-label">Product evidence</span>
          <h2 id="proof-heading">See what NeuralOps proves.</h2>
          <div className="landing__proof-tabs" aria-label="Product proof views">
            {proofItems.map((item, index) => (
              <button className={index === activeProof ? 'active' : ''} type="button" key={item.id} onClick={() => setActiveProof(index)}>
                <span>0{index + 1}</span><strong>{item.title}</strong><small>{item.body}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="landing__proof-media">
          <AnimatePresence mode="wait">
            <motion.figure key={proofItems[activeProof].id} initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? undefined : { opacity: 0, y: -12 }} transition={{ duration: 0.38 }}>
              <img src={proofItems[activeProof].image} width="1440" height="900" alt={proofItems[activeProof].alt} loading="lazy" />
              <figcaption><span>{proofItems[activeProof].kicker}</span><strong>Real interface, sanitized workspace</strong></figcaption>
            </motion.figure>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function PrivacyList({ title, items, included = false, reduceMotion }) {
  return (
    <motion.article initial={reduceMotion ? false : { opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.45 }}>
      <div><span>{included ? <Check weight="bold" /> : <X weight="bold" />}</span><h3>{title}</h3></div>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </motion.article>
  );
}

function AuthDialog({ onClose, onSession, reduceMotion }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      className="landing__auth-dialog"
      ref={dialogRef}
      aria-label="Sign in to NeuralOps"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      <motion.div initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.24 }}>
        <button className="landing__auth-close" type="button" autoFocus onClick={onClose} aria-label="Close sign in"><X weight="bold" /></button>
        <AuthGate onSession={onSession} allowSignup={false} />
      </motion.div>
    </dialog>
  );
}

function createPilotKey() {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `pilot_${value}`.slice(0, 160);
}

function readableError(error) {
  const message = String(error?.message || 'The server did not accept the request.');
  if (message.includes('429')) return 'Too many applications were sent from this connection. Please try again later.';
  if (message.includes('409')) return 'This application attempt is no longer valid. Reload the page and submit again.';
  return 'The server did not accept the request. Please verify the fields and try again.';
}
