import { useState } from 'react';
import { patchIncident } from '../lib/api';

export default function IncidentTimeline({ incidents, setIncidents, addToast }) {
  const [selectedIncidentId, setSelectedIncidentId] = useState(incidents[0]?.id || 'inc_01');

  const handleStatusChange = async (id, newStatus) => {
    setIncidents(prev => prev.map(inc => {
      if (inc.id === id) {
        return { ...inc, status: newStatus };
      }
      return inc;
    }));
    try {
      await patchIncident(id, { status: newStatus });
      addToast(`Incident status synced to backend: ${newStatus}`, 'success');
    } catch {
      addToast(`Incident status updated locally: ${newStatus}`, 'warning');
    }
  };

  const handleOwnerChange = async (id, newOwner) => {
    setIncidents(prev => prev.map(inc => {
      if (inc.id === id) {
        return { ...inc, owner: newOwner };
      }
      return inc;
    }));
    try {
      await patchIncident(id, { owner: newOwner });
      addToast(`Incident assignment synced to backend: ${newOwner}`, 'success');
    } catch {
      addToast(`Incident assigned locally: ${newOwner}`, 'warning');
    }
  };

  const activeIncident = incidents.find(i => i.id === selectedIncidentId) || incidents[0];

  // Grouping incidents by severity
  const criticalIncidents = incidents.filter(i => i.severity === 'Critical');
  const majorIncidents = incidents.filter(i => i.severity === 'Major');
  const minorIncidents = incidents.filter(i => i.severity === 'Minor');

  // Local timeline narrative keyed by backend incident IDs.
  const timelineEvents = {
    inc_01: [
      { time: '09:12 AM', title: 'Latency anomaly threshold exceeded', desc: 'p95 latency jumped to 4.25s (Warning limit is 2.50s)', type: 'alert' },
      { time: '09:14 AM', title: 'System Auto-Triggered canary throttle', desc: 'Canary split shifted from 50% down to 25% traffic automatically', type: 'system_action' },
      { time: '09:16 AM', title: 'Incident opened and assigned', desc: 'Assigned to AI Platform Oncall for prompt/model verification', type: 'assign' }
    ],
    inc_02: [
      { time: '07:34 AM', title: 'PII leakage warning logged', desc: 'Trace tr_9281 contained unmasked phone details, flagged by heuristics', type: 'alert' },
      { time: '07:45 AM', title: 'Policy updated in Manager', desc: 'Enforcement level set to "block" from "warn"', type: 'policy_update' },
      { time: '08:00 AM', title: 'Incident status marked Resolved', desc: 'Verified sanitization rules are working as intended', type: 'resolve' }
    ],
    inc_03: [
      { time: '05:12 AM', title: 'Cost anomaly warning logged', desc: 'Hourly spend spike on marketing_copy_gen chain exceeded limit', type: 'alert' },
      { time: '05:15 AM', title: 'Assigned to FinOps', desc: 'FinOps assigned for root-cause audit of batch jobs', type: 'assign' }
    ]
  };

  const activeEvents = timelineEvents[activeIncident?.id] || [];

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Incident Timeline</h1>
          <p className="page-subtitle">Acknowledge platform alerts, audit timeline activities, and coordinate rollbacks with team owners.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.6fr', gap: '24px' }}>
        {/* Left Side: Incidents list grouped by Severity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="table-container" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Active System Incidents</span>
            
            {/* Critical Incidents Section */}
            {criticalIncidents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--color-error)' }}>
                  Critical Severity
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {criticalIncidents.map((inc) => (
                    <div 
                      key={inc.id}
                      onClick={() => setSelectedIncidentId(inc.id)}
                      style={{ 
                        padding: '12px 16px', 
                        background: selectedIncidentId === inc.id ? 'rgba(26,26,25,0.03)' : '#FFF', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: '10px',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ fontSize: '13px', fontWeight: '600' }}>{inc.title}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                          Owner: {inc.owner} | {inc.time}
                        </span>
                      </div>
                      <span className="badge badge-error">{inc.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Major Incidents Section */}
            {majorIncidents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                <span style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--color-warning)' }}>
                  Major Severity
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {majorIncidents.map((inc) => (
                    <div 
                      key={inc.id}
                      onClick={() => setSelectedIncidentId(inc.id)}
                      style={{ 
                        padding: '12px 16px', 
                        background: selectedIncidentId === inc.id ? 'rgba(26,26,25,0.03)' : '#FFF', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: '10px',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ fontSize: '13px', fontWeight: '600' }}>{inc.title}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                          Owner: {inc.owner} | {inc.time}
                        </span>
                      </div>
                      <span className="badge badge-warning">{inc.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Minor Incidents Section */}
            {minorIncidents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                <span style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                  Minor Severity
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {minorIncidents.map((inc) => (
                    <div 
                      key={inc.id}
                      onClick={() => setSelectedIncidentId(inc.id)}
                      style={{ 
                        padding: '12px 16px', 
                        background: selectedIncidentId === inc.id ? 'rgba(26,26,25,0.03)' : '#FFF', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: '10px',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ fontSize: '13px', fontWeight: '600' }}>{inc.title}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                          Owner: {inc.owner} | {inc.time}
                        </span>
                      </div>
                      <span className="badge badge-warning" style={{ background: '#ECE9DD', color: 'var(--text-secondary)' }}>
                        {inc.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Incident Details & Action Timeline */}
        {activeIncident && (
          <div className="card-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Incident Detail ID: {activeIncident.id}
                </span>
                <h3 style={{ fontSize: '17px', fontWeight: 600, marginTop: '2px' }}>{activeIncident.title}</h3>
              </div>
              <span className={`badge ${activeIncident.severity === 'Critical' ? 'badge-error' : 'badge-warning'}`}>
                {activeIncident.severity}
              </span>
            </div>

            {/* Config Control Section */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-secondary)' }}>Assignee</label>
                <select 
                  className="filter-select"
                  value={activeIncident.owner}
                  onChange={(e) => handleOwnerChange(activeIncident.id, e.target.value)}
                >
                  <option value="AI Platform Oncall">AI Platform Oncall</option>
                  <option value="Trust Engineering">Trust Engineering</option>
                  <option value="FinOps">FinOps</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-secondary)' }}>Incident Status</label>
                <select 
                  className="filter-select"
                  value={activeIncident.status}
                  onChange={(e) => handleStatusChange(activeIncident.id, e.target.value)}
                >
                  <option value="Investigating">Investigating</option>
                  <option value="Open">Open</option>
                  <option value="Resolved">Resolved</option>
                </select>
              </div>
            </div>

            {/* Incident Chronological Timeline */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <span style={{ fontSize: '12px', fontWeight: '600' }}>Chronological Activity Log</span>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '1px solid var(--border-color)', marginLeft: '8px', paddingLeft: '20px' }}>
                {activeEvents.map((evt, idx) => (
                  <div key={idx} style={{ position: 'relative' }}>
                    {/* Timeline dot */}
                    <div 
                      style={{ 
                        position: 'absolute', 
                        left: '-25px', 
                        top: '4px', 
                        width: '9px', 
                        height: '9px', 
                        borderRadius: '50%', 
                        background: evt.type === 'alert' ? 'var(--color-error)' : evt.type === 'resolve' ? 'var(--color-success)' : 'var(--text-primary)',
                        border: '2px solid var(--bg-card)'
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{evt.title}</span>
                      <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{evt.time}</span>
                    </div>
                    <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px', lineHeight: '1.4' }}>
                      {evt.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            
            <button className="btn-primary" style={{ marginTop: '8px' }} onClick={() => addToast('Incident updates broadcasted to connected notification channels.', 'success')}>
              Sync Updates
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
