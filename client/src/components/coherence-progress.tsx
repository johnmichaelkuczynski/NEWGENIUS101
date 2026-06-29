// client/src/components/coherence-progress.tsx
import { useEffect, useState } from 'react';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';

interface CoherenceProgressProps {
  sseUrl: string;
  onComplete?: (finalText: string, coherenceStatus: string, documentId?: string) => void;
  onError?: (error: string) => void;
}

export function CoherenceProgress({
  sseUrl,
  onComplete,
  onError,
}: CoherenceProgressProps) {
  const [progress, setProgress] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [status, setStatus] = useState('processing');
  const [violations, setViolations] = useState(0);
  const [message, setMessage] = useState('Generating paper...');
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const [coherenceStatus, setCoherenceStatus] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'status') {
          setMessage(data.message);
        } else if (data.type === 'coherence_progress') {
          setCurrentChunk(data.chunk);
          setTotalChunks(data.total);
          setStatus(data.status);
          setViolations(data.violations || 0);
          setProgress(Math.round((data.chunk / data.total) * 100));
        } else if (data.type === 'final') {
          setFinalOutput(data.text);
          setCoherenceStatus(data.coherence);
          setDocumentId(data.documentId);
          onComplete?.(data.text, data.coherence, data.documentId);
          eventSource.close();
        } else if (data.type === 'error') {
          setError(data.message);
          onError?.(data.message);
          eventSource.close();
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE error:', err);
      setError('Connection lost. Please try again.');
      onError?.('Connection lost');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [sseUrl, onComplete, onError]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {message}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Coherence Processing</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} className="h-2" />
          <div className="text-xs text-muted-foreground">
            Chunk {currentChunk}/{totalChunks} • Status: {status} • Violations: {violations}
          </div>
        </div>

        {finalOutput && (
          <div className="mt-4 p-3 bg-muted rounded-md">
            <p className="text-sm font-medium">
              Complete • Coherence: {coherenceStatus}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}