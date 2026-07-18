import { useRef, useState } from 'react';
import AuthGate from './AuthGate';
import { submitPilotApplication } from '../lib/api';

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
    features: ['Everything in Developer', 'Shared approval queue', 'Credential rotation and revocation', 'Emergency stop and evidence exports'],
    featured: true,
  },
  {
    name: 'Business',
    price: '$499',
    cadence: '/ month',
    description: 'For multiple teams operating governed agents across production boundaries.',
    features: ['Everything in Team', 'Production access decisions', 'Retention policies and legal holds', 'Priority pilot onboarding'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'scoped with you',
    description: 'For organizations that need a documented security and deployment review.',
    features: ['Everything in Business', 'Architecture and security review', 'Deployment planning', 'Procurement-ready commercial terms'],
  },
];

export default function LandingPage({ onSession }) {
  const [authOpen, setAuthOpen] = useState(false);
  const [application, setApplication] = useState(EMPTY_APPLICATION);
  const [submission, setSubmission] = useState({ state: 'idle', message: '' });
  const idempotencyKey = useRef(createPilotKey());

  const handlePilotSubmit = async (event) => {
    event.preventDefault();
    setSubmission({ state: 'submitting', message: 'Submitting with one stable idempotency key; success will appear only after backend confirmation.' });
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
          <span className="landing__brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>NeuralOps</span>
        </a>
        <nav aria-label="Public navigation">
          <a href="#how-it-works">Control model</a>
          <a href="#privacy">Privacy</a>
          <a href="#pricing">Pricing</a>
          <button type="button" onClick={() => setAuthOpen(true)}>Sign in</button>
        </nav>
      </header>

      <main id="main">
        <section className="landing__hero" id="top">
          <div className="landing__hero-copy">
            <span className="landing__eyebrow">Authorization infrastructure for AI agents</span>
            <h1>Stop unsafe agent actions before they happen.</h1>
            <p>
              NeuralOps gives every agent a governed identity and requires authorization before every high-risk action—shell execution,
              writes, browser interaction, external communication, and secret access.
            </p>
            <div className="landing__hero-actions">
              <a className="landing__cta" href="#pilot">Apply for invited pilot</a>
              <a className="landing__secondary-link" href="#how-it-works">Inspect the control model <span aria-hidden="true">→</span></a>
            </div>
            <div className="landing__truth-strip" aria-label="Pilot operating model">
              <span><strong>5–20</strong> invited teams</span>
              <span><strong>Fail closed</strong> on high risk</span>
              <span><strong>Metadata</strong> by default</span>
            </div>
          </div>

          <div className="landing__control-preview" aria-label="Authorization sequence preview">
            <div className="landing__preview-head"><span>LIVE CONTROL PATH</span><span className="landing__live"><i /> ENFORCED</span></div>
            <div className="landing__agent-row">
              <span className="landing__node-index">01</span>
              <div><small>IDENTITY</small><strong>support-resolution-agent</strong><span>Owner / Customer Systems</span></div>
              <b>BOUND</b>
            </div>
            <div className="landing__path-line"><span>Requests browser.write</span><i /></div>
            <div className="landing__decision-row">
              <span className="landing__node-index">02</span>
              <div><small>POLICY DECISION</small><strong>Human approval required</strong><span>Production · high risk · no active lease</span></div>
              <b>BLOCK</b>
            </div>
            <div className="landing__preview-foot"><span>Raw arguments not retained</span><code>sha256:8f7a…d219</code></div>
          </div>
        </section>

        <aside className="landing__cold-start" aria-label="Pilot infrastructure disclosure">
          <span>FREE-INFRA PILOT</span>
          <p>The free-tier backend may need up to 90 seconds to wake. NeuralOps shows warming status, preserves the intended action with an idempotency key, and never reports success before the backend confirms it.</p>
        </aside>

        <section className="landing__control-model" id="how-it-works" aria-labelledby="control-heading">
          <div className="landing__section-lead">
            <span className="landing__eyebrow">The control model</span>
            <h2 id="control-heading">Permission is a runtime decision, not a policy document.</h2>
            <p>Built-in and external agents take the same enforcement path. High-risk actions cannot proceed on stale approval or backend unavailability.</p>
          </div>
          <ol className="landing__steps">
            <li><span>01 / IDENTIFY</span><h3>Give the agent boundaries</h3><p>Register an owner, environment, risk level, providers, and exact permissions. The scoped credential is shown once and stored only as a hash.</p></li>
            <li><span>02 / AUTHORIZE</span><h3>Check before the tool runs</h3><p>Allowlisted reads can receive short leases. Writes, shell, browser, communications, secrets, and destructive operations require current approval.</p></li>
            <li><span>03 / PROVE</span><h3>Keep auditable evidence</h3><p>Record actors, reasons, expiry, hashes, findings, status, cost, and timing without retaining the agent’s sensitive content.</p></li>
          </ol>
        </section>

        <section className="landing__privacy" id="privacy" aria-labelledby="privacy-heading">
          <div>
            <span className="landing__eyebrow">Privacy boundary</span>
            <h2 id="privacy-heading">Metadata by default. Content stays out.</h2>
          </div>
          <div className="landing__privacy-columns">
            <article><span className="landing__included">CAPTURED</span><ul><li>Agent, action, and tool category IDs</li><li>Timing, provider, model, tokens, and cost totals</li><li>Status, policy findings, and content hashes</li><li>Approval actors, reasons, expiry, and evidence</li></ul></article>
            <article><span className="landing__excluded">NOT CAPTURED</span><ul><li>Raw prompts or model outputs</li><li>Tool arguments, provider keys, or secrets</li><li>Uploaded files or browser content</li><li>Agent credentials after one-time issuance</li></ul></article>
          </div>
        </section>

        <section className="landing__pricing" id="pricing" role="region" aria-label="Pricing">
          <div className="landing__section-lead">
            <span className="landing__eyebrow">Pilot list pricing</span>
            <h2>Start with control. Pay when the team depends on it.</h2>
            <p>These are the intended post-pilot monthly prices. Pilot participation is invitation-only; billing activates only after commercial acceptance.</p>
          </div>
          <div className="landing__plans">
            {plans.map((plan) => (
              <article className={plan.featured ? 'landing__plan landing__plan--featured' : 'landing__plan'} key={plan.name}>
                <div><span>{plan.name}</span>{plan.featured && <b>PILOT DEFAULT</b>}</div>
                <strong>{plan.price}</strong><small>{plan.cadence}</small>
                <p>{plan.description}</p>
                <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
                <a href="#pilot">{plan.name === 'Enterprise' ? 'Discuss requirements' : 'Apply for pilot'}</a>
              </article>
            ))}
          </div>
        </section>

        <section className="landing__pilot" id="pilot" aria-labelledby="pilot-heading">
          <div className="landing__pilot-copy">
            <span className="landing__eyebrow">Invited pilot application</span>
            <h2 id="pilot-heading">Bring one real agent workflow.</h2>
            <p>We are selecting teams with a concrete agent, a named owner, and at least one meaningful tool boundary. The pilot validates control—not a staged demo.</p>
            <dl><div><dt>What happens next</dt><dd>We review fit, confirm the workflow, and schedule onboarding if accepted.</dd></div><div><dt>What we collect here</dt><dd>Contact and pilot-scoping metadata only. Do not submit prompts, secrets, provider keys, or customer data.</dd></div></dl>
          </div>

          <form className="landing__pilot-form" aria-label="Invited pilot application" onSubmit={handlePilotSubmit}>
            <div className="landing__field-row">
              <label>Name<input value={application.name} onChange={(event) => setApplication({ ...application, name: event.target.value })} required minLength="2" autoComplete="name" /></label>
              <label>Work email<input type="email" value={application.workEmail} onChange={(event) => setApplication({ ...application, workEmail: event.target.value })} required autoComplete="email" /></label>
            </div>
            <div className="landing__field-row">
              <label>Company<input value={application.company} onChange={(event) => setApplication({ ...application, company: event.target.value })} required minLength="2" autoComplete="organization" /></label>
              <label>Role <small>optional</small><input value={application.role} onChange={(event) => setApplication({ ...application, role: event.target.value })} autoComplete="organization-title" /></label>
            </div>
            <div className="landing__field-row">
              <label>Team size<select value={application.teamSize} onChange={(event) => setApplication({ ...application, teamSize: event.target.value })}><option value="1-5">1–5</option><option value="6-20">6–20</option><option value="21-50">21–50</option><option value="51+">51+</option></select></label>
              <label>Expected managed agents<input type="number" min="1" max="10000" value={application.expectedAgents} onChange={(event) => setApplication({ ...application, expectedAgents: event.target.value })} required /></label>
            </div>
            <label>Primary use case<textarea value={application.primaryUseCase} onChange={(event) => setApplication({ ...application, primaryUseCase: event.target.value })} required minLength="12" placeholder="Which agent acts, which tools it uses, and what must require approval?" /></label>
            <label className="landing__consent"><input type="checkbox" checked={application.consent} onChange={(event) => setApplication({ ...application, consent: event.target.checked })} required /><span>I agree to be contacted about the invited NeuralOps pilot and understand this form stores lead metadata.</span></label>
            <label className="landing__honeypot" aria-hidden="true">Website<input value={application.website} onChange={(event) => setApplication({ ...application, website: event.target.value })} tabIndex="-1" autoComplete="off" /></label>
            <button type="submit" disabled={submission.state === 'submitting'}>{submission.state === 'submitting' ? 'Submitting…' : 'Submit pilot application'}</button>
            {submission.message && <p className={`landing__form-status landing__form-status--${submission.state}`} role={submission.state === 'error' ? 'alert' : 'status'}>{submission.message}</p>}
          </form>
        </section>
      </main>

      <footer className="landing__footer"><a className="landing__brand" href="#top"><span className="landing__brand-mark" aria-hidden="true"><i /><i /><i /></span><span>NeuralOps</span></a><p>Supervised agent operations. Built for honest control.</p><button type="button" onClick={() => setAuthOpen(true)}>Operator sign in</button></footer>

      {authOpen && (
        <div className="landing__auth-scrim" onMouseDown={(event) => event.target === event.currentTarget && setAuthOpen(false)} onKeyDown={(event) => event.key === 'Escape' && setAuthOpen(false)}>
          <section className="landing__auth-modal" role="dialog" aria-modal="true" aria-label="Sign in to NeuralOps">
            <button className="landing__auth-close" type="button" autoFocus onClick={() => setAuthOpen(false)}>Close</button>
            <AuthGate onSession={onSession} allowSignup={false} />
          </section>
        </div>
      )}
    </div>
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
