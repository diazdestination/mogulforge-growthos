import { useEffect, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { FiArrowRight, FiBarChart2, FiCalendar, FiMail, FiShield } from 'react-icons/fi';
import { AGENT_STAGE_LABEL, AGENT_TEAM } from '@/lib/agent-team';
import './agent-team.css';

type Focus = 'all' | 'finance' | 'operations';

/** Specialists backed by proposal-only runs; their proposals wait for staff approval in Revenue Desk. */
const PROPOSAL_SPECIALISTS = ['scout', 'invo'] as const;
type PendingCounts = Partial<Record<(typeof PROPOSAL_SPECIALISTS)[number], number>>;

async function loadPendingCounts(): Promise<PendingCounts> {
  const counts: PendingCounts = {};
  await Promise.all(PROPOSAL_SPECIALISTS.map(async key => {
    try {
      const response = await fetch(`/api/v1/bie/specialists/${key}/proposals`, { credentials: 'include' });
      if (!response.ok) return;
      const rows = (await response.json()) as Array<{ status?: string }>;
      if (Array.isArray(rows)) counts[key] = rows.filter(row => row.status === 'proposed').length;
    } catch {
      // Counts are a convenience; the guide still works without them.
    }
  }));
  return counts;
}

const FILTERS: readonly { id: Focus; label: string }[] = [
  { id: 'all', label: 'All specialists' },
  { id: 'finance', label: 'Sales & finance' },
  { id: 'operations', label: 'Customer operations' },
];

export default function AgentTeam({ publicMode = false }: { publicMode?: boolean }) {
  const search = useSearch();
  const [focus, setFocus] = useState<Focus>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCounts>({});
  useEffect(() => {
    if (publicMode) return;
    let live = true;
    void loadPendingCounts().then(counts => { if (live) setPending(counts); });
    return () => { live = false; };
  }, [publicMode]);
  const pendingFor = (id: string) => (pending as Record<string, number | undefined>)[id];
  const visible = AGENT_TEAM.filter(agent =>
    focus === 'all' || agent.category === focus,
  );
  const selected = visible.find(agent => agent.id === selectedId);
  useEffect(() => {
    const id = new URLSearchParams(search).get('specialist');
    if (id && AGENT_TEAM.some(agent => agent.id === id)) { setFocus('all'); setSelectedId(id); }
  }, [search]);
  useEffect(() => {
    if (selected) {
      const heading = document.getElementById('agent-team-detail-heading');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  }, [selected]);

  return (
    <div className="agent-team">
      <div className="agent-team__frame">
        <header className="agent-team__masthead">
          <Link href="/" className="agent-team__brand" aria-label="MogulForge GrowthOS home">
            <img src="/brand/mogulforge-mark.svg" alt="" width="52" height="52" />
            <span className="agent-team__brand-copy">
              <strong>Mogul<span>Forge</span></strong>
              <small>POWERING CONTRACTOR GROWTH</small>
            </span>
          </Link>
          <div className="agent-team__headline">
            <p className="agent-team__visually-hidden">BUSINESS INTELLIGENCE ECOSYSTEM</p>
            <h1>Growth<span>OS</span></h1>
            <p>Clear roles. Connected work. Your team in control.</p>
          </div>
          <div className="agent-team__built-for">
            <FiShield aria-hidden="true" />
            <span><strong>BUILT FOR CONTRACTORS</strong><small>Roofing · HVAC · Restoration</small></span>
          </div>
        </header>

        <section className="agent-team__intro" aria-labelledby="agent-team-heading">
          <div>
            <p className="agent-team__kicker">THE GROWTHOS SPECIALISTS</p>
            <h2 id="agent-team-heading">A clear role for each part of the work.</h2>
            <p>Choose a specialist to explore its workspace, available tools and setup requirements.</p>
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
              <span className="agent-team__portrait-frame"><img className="agent-team__portrait" src={agent.portrait} alt="" loading={index > 3 ? 'lazy' : 'eager'} /></span>
              <span className="agent-team__card-copy">
                <span className="agent-team__card-name">{agent.name}</span>
                <span className="agent-team__card-role">{agent.role}</span>
                <span className="agent-team__card-promise">{agent.promise}</span>
                {pendingFor(agent.id) !== undefined && (
                  <span className="agent-team__pending">{pendingFor(agent.id)} awaiting approval</span>
                )}
                <span className="agent-team__specialties">
                  <strong>Workspace focus</strong>
                  {agent.tasks.filter(task => task.stage === 'workspace').slice(0, 2).map(task => <span key={task.title}>{task.title}</span>)}
                </span>
              </span>
              <span className="agent-team__card-footer">
                <span>View workspace guide</span>
                <FiArrowRight aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <section className="agent-team__details" aria-live="polite" aria-labelledby="agent-team-detail-heading">
            <div className="agent-team__detail-heading">
              <div>
                <p className="agent-team__kicker">WORKSPACE GUIDE · {selected.name}</p>
                <h2 id="agent-team-detail-heading" tabIndex={-1}>{selected.role}</h2>
                <p>{selected.promise}</p>
              </div>
              {selected.workspace ? (
                <Link className="agent-team__cta" href={publicMode ? '/login' : selected.workspace}>
                  {publicMode ? 'Sign in to open workspace' : selected.workspaceLabel} <FiArrowRight aria-hidden="true" />
                </Link>
              ) : (
                <span className="agent-team__not-live">Not available as an automated agent yet</span>
              )}
            </div>
            {pendingFor(selected.id) !== undefined && (
              <p className="agent-team__pending-detail">
                {selected.name} has {pendingFor(selected.id)} proposal{pendingFor(selected.id) === 1 ? '' : 's'} awaiting staff approval. Specialists only propose; nothing runs until your team approves it.{' '}
                <Link href="/bie">Review in Revenue Desk</Link>
              </p>
            )}
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
            <span><strong>ONE ECOSYSTEM. CLEAR ACCOUNTABILITY.</strong><small>Familiar specialists guide the tools. Your team reviews the business decisions.</small></span>
          </div>
          <div className="agent-team__footer-points" aria-label="Platform connections">
            <span><FiBarChart2 aria-hidden="true" /> CRM records</span>
            <span><FiMail aria-hidden="true" /> Email by setup</span>
            <span><FiCalendar aria-hidden="true" /> Appointments</span>
          </div>
          <p>Illustrated product specialists. Customer contact requires approved company setup.</p>
        </footer>
      </div>
    </div>
  );
}
