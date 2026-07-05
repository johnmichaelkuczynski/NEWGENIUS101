import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Users, Clock, CalendarDays, CalendarRange } from "lucide-react";

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
      </div>
    </div>
  );
}
