import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, BookOpen } from 'lucide-react';
import { AGENT_TEAM, AGENT_STAGE_LABEL, specialistContextFor } from '@/lib/agent-team';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import './specialist-context.css';

export function SpecialistContext({ location }: { location: string }) {
  const context = specialistContextFor(location);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setSelectedId(null); }, [location]);
  if (!context) return null;
  const specialists = context.ids.map(id => AGENT_TEAM.find(agent => agent.id === id)!);
  const selected = specialists.find(agent => agent.id === selectedId) ?? specialists[0];
  return <Sheet open={open} onOpenChange={setOpen}>
    <aside className="specialist-context" aria-label={`${context.workspace} specialist support`}>
      <div className="specialist-context__portraits" aria-hidden="true">{specialists.map(agent => <span key={agent.id}><img src={agent.portrait} alt="" /></span>)}</div>
      <div className="specialist-context__copy"><p>{specialists.map(agent => agent.name).join(' + ')} <span>· {context.workspace} support</span></p><span>{context.summary}</span></div>
      <SheetTrigger asChild><button type="button" className="specialist-context__guide"><BookOpen size={16} aria-hidden="true" /> <span>Workspace guide</span></button></SheetTrigger>
    </aside>
      <SheetContent side="right" className="specialist-guide" closeLabel="Close workspace guide">
        <SheetHeader className="specialist-guide__heading"><SheetTitle>{context.workspace} workspace guide</SheetTitle><SheetDescription>Know what the tools support and where your team’s review is required.</SheetDescription></SheetHeader>
        <Tabs value={selected.id} onValueChange={setSelectedId} className="specialist-guide__content">
        <TabsList className="specialist-guide__tabs" aria-label="Workspace specialists">{specialists.map(agent => <TabsTrigger key={agent.id} value={agent.id}>{agent.name}</TabsTrigger>)}</TabsList>
        <TabsContent value={selected.id} className="specialist-guide__body">
          <div className="specialist-guide__identity"><img src={selected.portrait} alt="" /><div><small>{selected.name}</small><h2>{selected.role}</h2><p>{selected.promise}</p></div></div>
          <ul className="specialist-guide__tasks">{selected.tasks.map(task => <li key={task.title}><small>{AGENT_STAGE_LABEL[task.stage]}</small><h3>{task.title}</h3><p>{task.reality}</p></li>)}</ul>
          <p className="specialist-guide__control">Your team reviews customer contact and financial changes. Follow your company’s setup and approval process before delivery.</p>
          <Link className="specialist-guide__directory" href={`/agent-team?specialist=${selected.id}`}>Meet the specialist team <ArrowRight size={16} aria-hidden="true" /></Link>
        </TabsContent>
        </Tabs>
      </SheetContent>
  </Sheet>;
}
