import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Users, Clock, CalendarDays, CalendarRange, KeyRound, Copy, Check, Plus } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

type SeriesPoint = { label: string; count: number };

type AdminVisitsResponse = {
  stats: {
    allTime: number;
    last24Hours: number;
    lastMonth: number;
    lastYear: number;
  };
  series: {
    last24Hours: SeriesPoint[];
    lastMonth: SeriesPoint[];
    lastYear: SeriesPoint[];
    allTime: SeriesPoint[];
  };
  visits: { id: number; email: string | null; visitedAt: string }[];
};

const RANGES = [
  { key: "last24Hours", label: "Last 24 Hours" },
  { key: "lastMonth", label: "Last Month" },
  { key: "lastYear", label: "Last Year" },
  { key: "allTime", label: "All Time" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

type ApiKeyRow = {
  id: number;
  label: string;
  keyPrefix: string;
  revoked: boolean;
  requestCount: number;
  lastUsedAt: string | null;
  createdAt: string;
};

type UniqueVisitorStats = {
  total: number;
  last24Hours: number;
  lastMonth: number;
  newLast24Hours: number;
  totalVisits: number;
};

function BarChart({ points }: { points: SeriesPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <div className="flex items-end gap-1 h-40 w-full" data-testid="chart-visits">
      {points.map((p, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <span className="text-[10px] text-muted-foreground">{p.count > 0 ? p.count : ""}</span>
          <div
            className="w-full bg-primary/70 rounded-t"
            style={{ height: `${(p.count / max) * 100}%`, minHeight: p.count > 0 ? 4 : 1 }}
            title={`${p.label}: ${p.count}`}
          />
          <span className="text-[9px] text-muted-foreground truncate w-full text-center">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function Admin() {
  const [range, setRange] = useState<RangeKey>("last24Hours");

  const { data, isLoading, error } = useQuery<AdminVisitsResponse>({
    queryKey: ["/api/admin/visits"],
  });

  const { data: uniqueStats } = useQuery<UniqueVisitorStats>({
    queryKey: ["/api/admin/unique-visitors"],
  });

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="outline" size="sm" className="gap-2" data-testid="link-back-home">
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
          </Link>
          <h1 className="text-2xl font-semibold" data-testid="text-admin-title">
            Login Analytics
          </h1>
        </div>

        {isLoading && <p className="text-muted-foreground" data-testid="text-loading">Loading…</p>}
        {error && (
          <p className="text-destructive" data-testid="text-admin-error">
            Not authorized. You must be signed in as the site owner.
          </p>
        )}

        {uniqueStats && (
          <Card data-testid="card-unique-visitors">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Users className="w-4 h-4" /> Unique Visitors (all visitors, not just logins)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-3xl font-bold" data-testid="text-unique-total">{uniqueStats.total}</div>
                  <div className="text-xs text-muted-foreground">All-time unique visitors</div>
                </div>
                <div>
                  <div className="text-3xl font-bold" data-testid="text-unique-24h">{uniqueStats.last24Hours}</div>
                  <div className="text-xs text-muted-foreground">Active in last 24h</div>
                </div>
                <div>
                  <div className="text-3xl font-bold" data-testid="text-unique-new-24h">{uniqueStats.newLast24Hours}</div>
                  <div className="text-xs text-muted-foreground">New in last 24h</div>
                </div>
                <div>
                  <div className="text-3xl font-bold" data-testid="text-unique-visits">{uniqueStats.totalVisits}</div>
                  <div className="text-xs text-muted-foreground">Total visits</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card data-testid="card-stat-24h">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Last 24 Hours
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-3xl font-bold" data-testid="text-stat-24h">{data.stats.last24Hours}</span>
                </CardContent>
              </Card>
              <Card data-testid="card-stat-month">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <CalendarDays className="w-4 h-4" /> Last Month
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-3xl font-bold" data-testid="text-stat-month">{data.stats.lastMonth}</span>
                </CardContent>
              </Card>
              <Card data-testid="card-stat-year">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <CalendarRange className="w-4 h-4" /> Last Year
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-3xl font-bold" data-testid="text-stat-year">{data.stats.lastYear}</span>
                </CardContent>
              </Card>
              <Card data-testid="card-stat-alltime">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Users className="w-4 h-4" /> All Time
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-3xl font-bold" data-testid="text-stat-alltime">{data.stats.allTime}</span>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle>Logins Over Time</CardTitle>
                  <div className="flex gap-1">
                    {RANGES.map((r) => (
                      <Button
                        key={r.key}
                        size="sm"
                        variant={range === r.key ? "default" : "outline"}
                        onClick={() => setRange(r.key)}
                        data-testid={`button-range-${r.key}`}
                      >
                        {r.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <BarChart points={data.series[range]} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Logins</CardTitle>
              </CardHeader>
              <CardContent>
                {data.visits.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-no-visits">No logins recorded yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b">
                          <th className="py-2 pr-4">Email</th>
                          <th className="py-2">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.visits.map((v) => (
                          <tr key={v.id} className="border-b last:border-0" data-testid={`row-visit-${v.id}`}>
                            <td className="py-2 pr-4">{v.email || "—"}</td>
                            <td className="py-2">{new Date(v.visitedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <ApiKeysPanel />
      </div>
    </div>
  );
}

function ApiKeysPanel() {
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keys, isLoading, error } = useQuery<ApiKeyRow[]>({
    queryKey: ["/api/keys"],
  });

  const createMutation = useMutation({
    mutationFn: async (label: string) => {
      const res = await apiRequest("POST", "/api/keys", { label });
      return res.json();
    },
    onSuccess: (data: { key: string; label: string }) => {
      setNewKey({ key: data.key, label: data.label });
      setCopied(false);
      setLabel("");
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/keys/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
    },
  });

  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — key is still visible for manual copy
    }
  };

  return (
    <Card data-testid="card-api-keys">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> API Keys
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate(label.trim() || "Unnamed key");
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label for new key (e.g. Mobile app)"
            className="flex-1 min-w-[200px]"
            maxLength={256}
            data-testid="input-key-label"
          />
          <Button type="submit" disabled={createMutation.isPending} className="gap-2" data-testid="button-create-key">
            <Plus className="w-4 h-4" />
            {createMutation.isPending ? "Creating…" : "Create Key"}
          </Button>
        </form>

        {createMutation.error && (
          <p className="text-destructive text-sm" data-testid="text-create-key-error">
            Failed to create key: {(createMutation.error as Error).message}
          </p>
        )}

        {newKey && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 space-y-2" data-testid="panel-new-key">
            <p className="text-sm font-medium">
              New key “{newKey.label}” created. Copy it now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm bg-background rounded px-2 py-1 break-all" data-testid="text-new-key">
                {newKey.key}
              </code>
              <Button size="sm" variant="outline" onClick={copyKey} className="gap-1" data-testid="button-copy-key">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNewKey(null)} data-testid="button-dismiss-key">
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {isLoading && <p className="text-muted-foreground text-sm" data-testid="text-keys-loading">Loading keys…</p>}
        {error && (
          <p className="text-destructive text-sm" data-testid="text-keys-error">
            Failed to load keys: {(error as Error).message}
          </p>
        )}

        {keys && (keys.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="text-no-keys">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Label</th>
                  <th className="py-2 pr-4">Key</th>
                  <th className="py-2 pr-4">Requests</th>
                  <th className="py-2 pr-4">Last Used</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className={`border-b last:border-0 ${k.revoked ? "opacity-60" : ""}`} data-testid={`row-key-${k.id}`}>
                    <td className="py-2 pr-4">{k.label}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{k.keyPrefix}</td>
                    <td className="py-2 pr-4" data-testid={`text-key-requests-${k.id}`}>{k.requestCount}</td>
                    <td className="py-2 pr-4">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}</td>
                    <td className="py-2 pr-4">{new Date(k.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4">
                      {k.revoked ? (
                        <span className="text-destructive" data-testid={`status-key-${k.id}`}>Revoked</span>
                      ) : (
                        <span className="text-green-600 dark:text-green-500" data-testid={`status-key-${k.id}`}>Active</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {!k.revoked && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={revokeMutation.isPending}
                          onClick={() => {
                            if (window.confirm(`Revoke key "${k.label}"? Apps using it will stop working.`)) {
                              revokeMutation.mutate(k.id);
                            }
                          }}
                          data-testid={`button-revoke-key-${k.id}`}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
