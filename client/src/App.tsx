import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { SiGoogle } from "react-icons/si";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { PopupManagerProvider } from "@/contexts/popup-manager-context";
import { MultiPopupManager } from "@/components/ui/multi-popup-manager";
import { VoiceDictation } from "@/components/voice-dictation";
import Chat from "@/pages/chat";
import Diagnostics from "@/pages/diagnostics";
import Admin from "@/pages/admin";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery<{
    authenticated: boolean;
    user: { id: number; username: string; email: string | null; displayName: string | null } | null;
  }>({
    queryKey: ["/api/auth/user"],
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!data?.authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight" data-testid="text-login-title">Genius 101</h1>
            <p className="text-muted-foreground" data-testid="text-login-subtitle">
              Sign in with Google to continue
            </p>
          </div>
          <a
            href="/api/auth/google"
            target="_top"
            className="inline-flex items-center justify-center gap-2 w-full rounded-md bg-primary text-primary-foreground px-4 py-3 font-medium hover:opacity-90"
            data-testid="button-login-google"
          >
            <SiGoogle className="w-4 h-4" />
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Chat} />
      <Route path="/diagnostics" component={Diagnostics} />
      <Route path="/admin" component={Admin} />
      <Route path="/model-builder">
        <Redirect to="/" />
      </Route>
      <Route path="/paper-writer">
        <Redirect to="/" />
      </Route>
      <Route path="*">
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <PopupManagerProvider>
            <Toaster />
            <AuthGate>
              <Router />
            </AuthGate>
            <VoiceDictation />
            <MultiPopupManager />
          </PopupManagerProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
