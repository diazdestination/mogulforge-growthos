/**
 * Lead Capture: connect a company's EXISTING website forms and outside
 * systems (Zapier/Make/CRMs) to the pipeline. Admins create tokenized
 * inbound endpoints, map external payload fields to MogulForge lead fields,
 * preview a test payload against the mapping, and grab the paste-in form
 * listener snippet. Also documents the programmatic lead API.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListCaptureEndpoints,
  useCreateCaptureEndpoint,
  useUpdateCaptureEndpoint,
  useDeleteCaptureEndpoint,
  usePreviewCaptureMapping,
  getListCaptureEndpointsQueryKey,
  type CaptureEndpoint,
  type CaptureMappingPreview,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Copy, Loader2, Plus, Trash2, Webhook } from 'lucide-react';
import { SmartSitesControl } from '@/components/smart-sites-control';

const TARGET_FIELDS = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'addressLine1',
  'city',
  'state',
  'postalCode',
  'message',
  'source',
  'campaign',
  'externalId',
] as const;

interface MappingRow {
  external: string;
  target: string;
}

const SAMPLE_PAYLOAD = JSON.stringify(
  { 'your-name': 'Jane Homeowner', 'your-email': 'jane@example.com', 'your-phone': '555-0100', comments: 'Need help as soon as possible' },
  null,
  2,
);

export default function Capture() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: endpoints, isLoading } = useListCaptureEndpoints();

  const [name, setName] = useState('');
  const [defaultSource, setDefaultSource] = useState('website-form');
  const [rows, setRows] = useState<MappingRow[]>([
    { external: '', target: 'email' },
  ]);
  const [testPayload, setTestPayload] = useState(SAMPLE_PAYLOAD);
  const [preview, setPreview] = useState<CaptureMappingPreview | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListCaptureEndpointsQueryKey() });

  const createEndpoint = useCreateCaptureEndpoint({
    mutation: {
      onSuccess: () => {
        invalidate();
        setName('');
        toast({ title: 'Capture endpoint created' });
      },
      onError: () =>
        toast({ title: 'Could not create the endpoint', variant: 'destructive' }),
    },
  });
  const updateEndpoint = useUpdateCaptureEndpoint({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () =>
        toast({ title: 'Could not update the endpoint', variant: 'destructive' }),
    },
  });
  const deleteEndpoint = useDeleteCaptureEndpoint({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Endpoint deactivated' });
      },
      onError: () =>
        toast({ title: 'Could not deactivate the endpoint', variant: 'destructive' }),
    },
  });
  const previewMapping = usePreviewCaptureMapping({
    mutation: {
      onSuccess: (data) => setPreview(data),
      onError: () =>
        toast({ title: 'Preview failed — check the mapping and payload', variant: 'destructive' }),
    },
  });

  const mappingFromRows = (): Record<string, string> | null => {
    const mapping: Record<string, string> = {};
    for (const row of rows) {
      const key = row.external.trim();
      if (!key) continue;
      mapping[key] = row.target;
    }
    return Object.keys(mapping).length ? mapping : null;
  };

  const handleCreate = () => {
    const mapping = mappingFromRows();
    if (!name.trim() || !mapping) {
      toast({
        title: 'Name and at least one field mapping are required',
        variant: 'destructive',
      });
      return;
    }
    createEndpoint.mutate({ data: { name: name.trim(), mapping, defaultSource } });
  };

  const handlePreview = () => {
    const mapping = mappingFromRows();
    if (!mapping) {
      toast({ title: 'Add at least one field mapping first', variant: 'destructive' });
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(testPayload);
    } catch {
      toast({ title: 'Test payload must be valid JSON', variant: 'destructive' });
      return;
    }
    previewMapping.mutate({ data: { mapping, payload } });
  };

  const copy = async (text: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied` });
    } catch {
      toast({
        title: "Could not copy",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
      <div className="space-y-6 p-4 md:p-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Webhook className="h-6 w-6" aria-hidden="true" /> Lead Capture
          </h1>
          <p className="text-sm text-muted-foreground">
            Keep your current website or connect a MogulForge Smart Site.
            Set up lead delivery, choose who responds, and verify the connection
            before turning it on.
          </p>
        </div>

        <SmartSitesControl />

        <details className="space-y-5 rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">Advanced: existing forms & developer APIs</summary>
        <Card>
          <CardHeader>
            <CardTitle>New capture endpoint</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="capture-name">Name</Label>
                <Input
                  id="capture-name"
                  data-testid="input-capture-name"
                  value={name}
                  placeholder="e.g. Contact form on oldsite.com"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="capture-source">Lead source label</Label>
                <Input
                  id="capture-source"
                  data-testid="input-capture-source"
                  value={defaultSource}
                  onChange={(e) => setDefaultSource(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Field mapping (their field → our field)</Label>
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`External field ${i + 1}`}
                    data-testid={`input-external-field-${i}`}
                    placeholder="external field name, e.g. your-email"
                    value={row.external}
                    onChange={(e) =>
                      setRows((r) =>
                        r.map((x, j) => (j === i ? { ...x, external: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="text-muted-foreground">→</span>
                  <Select
                    value={row.target}
                    onValueChange={(v) =>
                      setRows((r) => r.map((x, j) => (j === i ? { ...x, target: v } : x)))
                    }
                  >
                    <SelectTrigger
                      className="w-44"
                      aria-label={`MogulForge field ${i + 1}`}
                      data-testid={`select-target-field-${i}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove mapping row ${i + 1}`}
                    onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                data-testid="button-add-mapping-row"
                onClick={() => setRows((r) => [...r, { external: '', target: 'phone' }])}
              >
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" /> Add field
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="capture-test-payload">Test payload (JSON)</Label>
              <Textarea
                id="capture-test-payload"
                data-testid="input-test-payload"
                rows={5}
                className="font-mono text-xs"
                value={testPayload}
                onChange={(e) => setTestPayload(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  data-testid="button-preview-mapping"
                  onClick={handlePreview}
                  disabled={previewMapping.isPending}
                >
                  {previewMapping.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
                  ) : null}
                  Preview mapping
                </Button>
                <Button
                  data-testid="button-create-endpoint"
                  onClick={handleCreate}
                  disabled={createEndpoint.isPending}
                >
                  {createEndpoint.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
                  ) : null}
                  Create endpoint
                </Button>
              </div>
            </div>

            {preview && (
              <div
                className="rounded-md border p-3 text-sm space-y-1"
                data-testid="mapping-preview-result"
              >
                <p className="font-medium">This payload would create:</p>
                {(
                  [
                    ['Name', [preview.firstName, preview.lastName].filter(Boolean).join(' ')],
                    ['Email', preview.email],
                    ['Phone', preview.phone],
                    ['Message', preview.message],
                    ['Source', preview.source],
                    ['Campaign', preview.campaign],
                  ] as const
                ).map(([label, value]) =>
                  value ? (
                    <p key={label}>
                      <span className="text-muted-foreground">{label}:</span> {value}
                    </p>
                  ) : null,
                )}
                {!preview.email && !preview.phone && (
                  <p className="text-destructive">
                    No email or phone mapped — submissions would be rejected.
                  </p>
                )}
                {preview.unmapped.length > 0 && (
                  <p className="text-muted-foreground">
                    Unmapped fields ignored: {preview.unmapped.join(', ')}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your capture endpoints</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading endpoints" />
            ) : !endpoints?.length ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-endpoints">
                No capture endpoints yet. Create one above, then point your form,
                Zapier zap, or webhook at its URL.
              </p>
            ) : (
              endpoints.map((e: CaptureEndpoint) => (
                <div key={e.id} className="rounded-md border p-4 space-y-2" data-testid={`endpoint-${e.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{e.name}</span>
                      <Badge variant={e.isActive ? 'default' : 'secondary'}>
                        {e.isActive ? 'Active' : 'Off'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {e.receivedCount} received
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-toggle-${e.id}`}
                        onClick={() =>
                          updateEndpoint.mutate({ id: e.id, data: { isActive: !e.isActive } })
                        }
                      >
                        {e.isActive ? 'Turn off' : 'Turn on'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Deactivate ${e.name}`}
                        onClick={() => deleteEndpoint.mutate({ id: e.id })}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {e.url && (
                    <div className="flex items-center gap-2">
                      <Input readOnly value={e.url} className="font-mono text-xs" aria-label={`Webhook URL for ${e.name}`} />
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`Copy webhook URL for ${e.name}`}
                        onClick={() => copy(e.url!, 'Webhook URL')}
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                  {e.embedSnippet && (
                    <div className="flex items-center gap-2">
                      <Textarea
                        readOnly
                        rows={2}
                        value={e.embedSnippet}
                        className="font-mono text-xs"
                        aria-label={`Form listener snippet for ${e.name}`}
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`Copy form listener snippet for ${e.name}`}
                        onClick={() => copy(e.embedSnippet!, 'Snippet')}
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Mapping:{' '}
                    {Object.entries(e.mapping ?? {})
                      .map(([k, v]) => `${k} → ${v}`)
                      .join(', ') || 'none'}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lead API for developers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Outside systems can also use the authenticated REST API. Create an API
              key in Settings, then send it as the <code className="font-mono">x-api-key</code>{' '}
              header. All calls are scoped to your company and rate-limited per key
              (240 requests/minute).
            </p>
            <ul className="list-disc pl-5 space-y-1 font-mono text-xs">
              <li>POST /api/v1/leads — create a lead (existing contactId required)</li>
              <li>PATCH /api/v1/leads/:id — update status, owner, details</li>
              <li>GET /api/v1/leads/:id — retrieve a lead</li>
              <li>POST /api/v1/leads/:id/activities — add a timeline event</li>
              <li>POST /api/v1/public/capture/:token — submit an external form payload</li>
            </ul>
            <p>
              Send an <code className="font-mono">x-idempotency-key</code> header on
              create calls: retried requests return the original result instead of
              creating duplicates. Outbound webhooks (Settings → Webhooks) fire on{' '}
              <code className="font-mono">
                lead.created, lead.qualified, lead.replied, lead.won, lead.lost,
                appointment.booked, appointment.cancelled
              </code>
              .
            </p>
          </CardContent>
        </Card>
        </details>
      </div>
  );
}
