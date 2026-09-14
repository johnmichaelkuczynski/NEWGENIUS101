import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { PopupManagerProvider } from "@/contexts/popup-manager-context";
import { MultiPopupManager } from "@/components/ui/multi-popup-manager";
import { VoiceDictation } from "@/components/voice-dictation";
import Chat from "@/pages/chat";
import ChatV2 from "@/pages/chat-v2";
import Diagnostics from "@/pages/diagnostics";
import Admin from "@/pages/admin";

function VisitorCounter() {
  const { data } = useQuery<{ total: number }>({
    queryKey: ["/api/visitors/count"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <div
      className="fixed left-3 top-3 z-[100] rounded-full border border-primary/30 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg"
      aria-label={`${data?.total ?? 0} visitors`}
      data-testid="visitor-counter"
    >
      {(data?.total ?? 0).toLocaleString()} total visitors
    </div>
  );
}


function Router() {
  return (
    <Switch>
      <Route path="/" component={Chat} />
      <Route path="/v2" component={ChatV2} />
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
  // Anonymous unique-visitor tracking (admin-only analytics)
  useEffect(() => {
    fetch("/api/track-visit", { method: "POST", credentials: "include" })
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/visitors/count"] }))
      .catch(() => {});
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <PopupManagerProvider>
            <Toaster />
            <Router />
            <VisitorCounter />
            <VoiceDictation />
            <MultiPopupManager />
          </PopupManagerProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

