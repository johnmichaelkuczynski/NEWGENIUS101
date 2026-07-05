import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Users, Clock, CalendarDays, CalendarRange } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

type LoginRecord = {
  email: string;
  firstVisit: string;
  lastVisit: string;
  visitCount: number;
};

type AdminData = {
  records: LoginRecord[];
  uniqueUsers: { allTime: number; last24h: number; lastMonth: number; lastYear: number };
  graphs: {
    last24h: { label: string; users: number }[];
    lastMonth: { label: string; users: number }[];
    lastYear: { label: string; users: number }[];
    allTime: { label: string; users: number }[];
  };
};

function StatCard({ title, value, icon: Icon }: { title: string; value: number; icon: any }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s+/g, "-")}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function LoginGraph({ title, data }: { title: string; data: { label: string; users: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No logins in this period</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="users" fill="hsl(24 60% 45%)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default function Admin() {
  const { data: userData, isLoading: userLoading } = useQuery<{
    user: { email?: string | null; isAdmin?: boolean } | null;
  }>({ queryKey: ["/api/user"] });

  const isAdmin = !!userData?.user?.isAdmin;

  const { data, isLoading, error } = useQuery<AdminData>({
    queryKey: ["/api/admin/logins"],
    enabled: isAdmin,
  });

  if (userLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <h1 className="text-2xl font-semibold" data-testid="text-access-denied">Access denied</h1>
        <p className="text-muted-foreground text-center max-w-md">
          This page is only available to the administrator.
          {!userData?.user && " Please sign in with Google first."}
        </p>
        <div className="flex gap-2">
          {!userData?.user && (
            <Button
              onClick={() => {
                const w = window.open("/api/auth/google", "_blank", "noopener");
                if (!w) window.location.href = "/api/auth/google";
              }}
              data-testid="button-admin-signin"
            >
              Sign in with Google
            </Button>
          )}
          <Link href="/">
            <Button variant="outline" data-testid="link-back-home">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to app
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold" data-testid="text-admin-title">Admin — Login Analytics</h1>
            <p className="text-muted-foreground text-sm mt-1">Every Google login recorded for this app</p>
          </div>
          <Link href="/">
            <Button variant="outline" data-testid="link-back">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to app
            </Button>
          </Link>
        </div>

        {isLoading && <p className="text-muted-foreground">Loading analytics…</p>}
        {error && <p className="text-destructive">Failed to load analytics.</p>}

        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard title="Unique Users (All Time)" value={data.uniqueUsers.allTime} icon={Users} />
              <StatCard title="Last 24 Hours" value={data.uniqueUsers.last24h} icon={Clock} />
              <StatCard title="Last Month" value={data.uniqueUsers.lastMonth} icon={CalendarDays} />
              <StatCard title="Last Year" value={data.uniqueUsers.lastYear} icon={CalendarRange} />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <LoginGraph title="Unique Users — Last 24 Hours (by hour)" data={data.graphs.last24h} />
              <LoginGraph title="Unique Users — Last Month (by day)" data={data.graphs.lastMonth} />
              <LoginGraph title="Unique Users — Last Year (by month)" data={data.graphs.lastYear} />
              <LoginGraph title="Unique Users — All Time (by month)" data={data.graphs.allTime} />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">All Logins ({data.records.length} users)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Gmail</th>
                        <th className="py-2 pr-4 font-medium">First Visit</th>
                        <th className="py-2 pr-4 font-medium">Last Visit</th>
                        <th className="py-2 font-medium">Visit Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.records.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-muted-foreground">
                            No logins recorded yet
                          </td>
                        </tr>
                      )}
                      {data.records.map((r) => (
                        <tr key={r.email} className="border-b last:border-0" data-testid={`row-login-${r.email}`}>
                          <td className="py-2 pr-4 font-medium" data-testid={`text-email-${r.email}`}>{r.email}</td>
                          <td className="py-2 pr-4">{new Date(r.firstVisit).toLocaleString()}</td>
                          <td className="py-2 pr-4">{new Date(r.lastVisit).toLocaleString()}</td>
                          <td className="py-2" data-testid={`text-visits-${r.email}`}>{r.visitCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
