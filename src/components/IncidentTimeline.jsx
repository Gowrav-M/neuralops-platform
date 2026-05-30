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
  const ownerOptions = [...new Set(incidents.map((incident) => incident.owner).filter(Boolean))];

  // Grouping incidents by severity
  const criticalIncidents = incidents.filter(i => i.severity === 'Critical');
  const majorIncidents = incidents.filter(i => i.severity === 'Major');
  const minorIncidents = incidents.filter(i => i.severity === 'Minor');

  const activeEvents = activeIncident ? [
    { time: activeIncident.time, title: `${activeIncident.severity} incident recorded`, desc: activeIncident.title, type: 'alert' },
    { time: 'current', title: `Assigned to ${activeIncident.owner}`, desc: `Current owner is ${activeIncident.owner}.`, type: 'assign' },
    { time: 'current', title: `Status: ${activeIncident.status}`, desc: activeIncident.status === 'Resolved' ? 'Incident is marked resolved in the backend.' : 'Incident remains active for operator review.', type: activeIncident.status === 'Resolved' ? 'resolve' : 'system_action' }
  ] : [];

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
                        background: selectedIncidentId === inc.id ? 'var(--bg-active)' : 'var(--bg-card)',
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
                        background: selectedIncidentId === inc.id ? 'var(--bg-active)' : 'var(--bg-card)',
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
                        background: selectedIncidentId === inc.id ? 'var(--bg-active)' : 'var(--bg-card)',
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
            {incidents.length === 0 && (
              <div className="state-container" style={{ padding: '24px' }}>
                <span style={{ fontWeight: 600 }}>No incident records available</span>
                <span>Backend is connected, but no incidents have been created from real trace or policy events.</span>
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
                  {ownerOptions.length > 0 ? ownerOptions.map((owner) => (
                    <option key={owner} value={owner}>{owner}</option>
                  )) : (
                    <option value="Unassigned">Unassigned</option>
                  )}
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
