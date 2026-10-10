import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { FiArrowRight, FiBarChart2, FiCalendar, FiMail, FiShield } from 'react-icons/fi';
import { AGENT_STAGE_LABEL, AGENT_TEAM, type AgentProfile } from '@/lib/agent-team';
import './agent-team.css';

type Focus = 'all' | 'workspace' | 'future';

const FILTERS: readonly { id: Focus; label: string }[] = [
  { id: 'all', label: 'All eight' },
  { id: 'workspace', label: 'Open a workspace' },
  { id: 'future', label: 'Still in build' },
];

function statusLabel(agent: AgentProfile): string {
  if (!agent.workspace) return 'In build';
  if (agent.tasks.some(task => task.stage === 'setup')) return 'Workspace + setup';
  return 'Workspace available';
}

export default function AgentTeam({ publicMode = false }: { publicMode?: boolean }) {
  const [focus, setFocus] = useState<Focus>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visible = AGENT_TEAM.filter(agent =>
    focus === 'all' || (focus === 'workspace' ? !!agent.workspace : !agent.workspace),
  );
  const selected = visible.find(agent => agent.id === selectedId);
  useEffect(() => {
    if (selected) document.getElementById('agent-team-detail-heading')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  return (
    <div className="agent-team">
      <div className="agent-team__frame">
        <header className="agent-team__masthead">
          <Link href="/" className="agent-team__brand" aria-label="MogulForge GrowthOS home">
            <img src="/brand/mogulforge-mark.svg" alt="" width="52" height="52" />
            <span className="agent-team__brand-copy">
              <strong>MOGULFORGE</strong>
              <small>POWERING CONTRACTOR GROWTH</small>
            </span>
          </Link>
          <div className="agent-team__headline">
            <p className="agent-team__visually-hidden">BUSINESS INTELLIGENCE ECOSYSTEM</p>
            <h1>Growth<span>OS</span></h1>
            <p>Your business command center, built around the work contractors actually do.</p>
          </div>
          <div className="agent-team__built-for">
            <FiShield aria-hidden="true" />
            <span><strong>BUILT FOR CONTRACTORS</strong><small>Roofing · HVAC · Restoration</small></span>
          </div>
        </header>

        <section className="agent-team__intro" aria-labelledby="agent-team-heading">
          <div>
            <p className="agent-team__kicker">THE GROWTHOS TEAM</p>
            <h2 className="agent-team__visually-hidden" id="agent-team-heading">Meet the specialists behind the work.</h2>
            <p>Eight specialists. One governed operating system. Select a profile to see what is ready today.</p>
          </div>
          <div className="agent-team__filters" role="group" aria-label="Filter agent profiles">
            {FILTERS.map(filter => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={focus === filter.id}
                className={focus === filter.id ? 'agent-team__filter agent-team__filter--active' : 'agent-team__filter'}
                onClick={() => setFocus(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </section>

        <div className="agent-team__grid">
          {visible.map((agent, index) => (
            <button
              className={`agent-team__card${selected?.id === agent.id ? ' agent-team__card--selected' : ''}`}
              type="button"
              key={agent.id}
              aria-pressed={selected?.id === agent.id}
              aria-label={`View ${agent.name}, ${agent.role}`}
              onClick={() => setSelectedId(agent.id)}
            >
              <span className="agent-team__number">{AGENT_TEAM.indexOf(agent) + 1}</span>
              <span className="agent-team__portrait-frame"><img className="agent-team__portrait" src={agent.portrait} alt="" loading={index > 3 ? 'lazy' : 'eager'} /></span>
              <span className="agent-team__card-copy">
                <span className="agent-team__card-name">{agent.name}</span>
                <span className="agent-team__card-role">{agent.role}</span>
                <span className="agent-team__card-promise">{agent.promise}</span>
                <span className="agent-team__specialties">
                  <strong>Specializes in</strong>
                  {agent.tasks.map(task => <span key={task.title}>· {task.title}</span>)}
                </span>
              </span>
              <span className="agent-team__card-footer">
                <span>{statusLabel(agent)}</span>
                <FiArrowRight aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <section className="agent-team__details" aria-live="polite" aria-labelledby="agent-team-detail-heading">
            <div className="agent-team__detail-heading">
              <div>
                <p className="agent-team__kicker">CAPABILITY CHECK · {selected.name}</p>
                <h2 id="agent-team-detail-heading">{selected.role}</h2>
                <p>{selected.promise}</p>
              </div>
              {selected.workspace ? (
                <Link className="agent-team__cta" href={publicMode ? '/signup' : selected.workspace}>
                  {publicMode ? 'Explore GrowthOS' : selected.workspaceLabel} <FiArrowRight aria-hidden="true" />
                </Link>
              ) : (
                <span className="agent-team__not-live">Not available as an automated agent yet</span>
              )}
            </div>
            <div className="agent-team__task-grid">
              {selected.tasks.map(task => (
                <div key={task.title} className="agent-team__task">
                  <span className={`agent-team__task-stage agent-team__task-stage--${task.stage}`}>{AGENT_STAGE_LABEL[task.stage]}</span>
                  <h3>{task.title}</h3>
                  <p>{task.reality}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="agent-team__footer">
          <div className="agent-team__footer-mission">
            <FiShield aria-hidden="true" />
            <span><strong>ONE ECOSYSTEM. CLEAR ACCOUNTABILITY.</strong><small>Specialists share a governed customer and job record. People approve consequential actions.</small></span>
          </div>
          <div className="agent-team__footer-points" aria-label="Platform connections">
            <span><FiBarChart2 aria-hidden="true" /> CRM records</span>
            <span><FiMail aria-hidden="true" /> Email by setup</span>
            <span><FiCalendar aria-hidden="true" /> Appointments</span>
          </div>
          <p>Product vision with capability status. No live customer outreach is implied.</p>
        </footer>
      </div>
    </div>
  );
}
