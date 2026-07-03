import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, Copy, Trash2, Download, MessageSquare, BookOpen, Square } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DragDropUpload } from "@/components/ui/drag-drop-upload";
import { useQuery } from "@tanstack/react-query";
import type { Figure } from "@shared/schema";
import { usePopupManager } from "@/contexts/popup-manager-context";
import { ElevenLabsOutput } from "@/components/elevenlabs-output";

function getDisplayName(fullName: string): string {
  const keepFullName = ["James Allen", "William James", "ALLEN"];
  if (keepFullName.includes(fullName)) {
    return fullName;
  }
  const parts = fullName.split(' ');
  return parts[parts.length - 1];
}

interface DialogueCreatorSectionProps {
  onRegisterInput?: (setter: (content: string) => void) => void;
  onRegisterOutputs?: (outputGetters: Record<string, () => string>) => void;
}

export function DialogueCreatorSection({ 
  onRegisterInput, 
  onRegisterOutputs 
}: DialogueCreatorSectionProps) {
  const [mode, setMode] = useState<'paste' | 'upload'>('paste');
  const [inputText, setInputText] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedAuthor1, setSelectedAuthor1] = useState<string>('');
  const [selectedAuthor2, setSelectedAuthor2] = useState<string>('');
  const [selectedAuthor3, setSelectedAuthor3] = useState<string>('');
  const [selectedAuthor4, setSelectedAuthor4] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [dialogue, setDialogue] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [wordLengthInput, setWordLengthInput] = useState<string>('1500');
  const [elevenLabsMode, setElevenLabsMode] = useState(false);
  const [canContinue, setCanContinue] = useState(false);
  const dialoguePopupIdRef = useRef<string>('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadedFileRef = useRef<File | null>(null);
  const lastSourceFileRef = useRef<File | null>(null);
  const lastSourceTextRef = useRef<string>('');
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [uploadedFileSize, setUploadedFileSize] = useState(0);
  const { toast } = useToast();
  const { registerPopup, updatePopup } = usePopupManager();

  // Fetch available authors/figures
  const { data: figures = [] } = useQuery<Figure[]>({
    queryKey: ['/api/figures'],
  });

  // Register input setter for content transfer system
  useEffect(() => {
    if (onRegisterInput) {
      onRegisterInput((content: string) => {
        setInputText(content);
        setMode('paste');
      });
    }
  }, [onRegisterInput]);

  // Register output getters for content transfer
  useEffect(() => {
    if (onRegisterOutputs) {
      onRegisterOutputs({
        dialogue: () => dialogue
      });
    }
  }, [onRegisterOutputs, dialogue]);

  const handleFileAccepted = async (file: File) => {
    const fileExtension = file.name.split('.').pop()?.toLowerCase();

    // Store the file for backend processing
    uploadedFileRef.current = file;
    setUploadedFileName(file.name);
    setUploadedFileSize(file.size);

    // For preview purposes only, show first part if it's a text file
    if (fileExtension === 'txt') {
      try {
        const text = await file.text();
        setInputText(text.slice(0, 500));
        toast({
          title: "File uploaded",
          description: `${file.name} ready (${file.size} bytes)`,
        });
      } catch (error) {
        setInputText(`File uploaded: ${file.name}`);
        toast({
          title: "File uploaded",
          description: file.name,
        });
      }
    } else {
      setInputText(`File uploaded: ${file.name} (${fileExtension?.toUpperCase() || 'FILE'})`);
      toast({
        title: "File uploaded",
        description: `${file.name} will be processed by server`,
      });
    }
  };

  const handleValidationError = (error: { title: string; description: string }) => {
    toast({
      title: error.title,
      description: error.description,
      variant: "destructive",
    });
  };

  const handleClearFile = () => {
    uploadedFileRef.current = null;
    setUploadedFileName('');
    setUploadedFileSize(0);
    setInputText('');
  };

  const handleGenerate = () => runGeneration('new');
  const handleContinue = () => runGeneration('continue');
  const handleSequel = () => runGeneration('sequel');
  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  const runGeneration = async (mode: 'new' | 'continue' | 'sequel') => {
    const isContinue = mode === 'continue';
    const isSequel = mode === 'sequel';

    // Continue/sequel modes require an existing dialogue to work from
    if ((isContinue || isSequel) && !dialogue.trim()) {
      return;
    }

    // Capture the prior dialogue BEFORE we clear state (used as sequel context).
    const priorDialogueText = isSequel ? dialogue : '';

    // Resolve the source text/file. For a sequel we reuse the source from the
    // last generation (the file may have been cleared from the active upload,
    // and the textarea may have been edited) so the sequel keeps the SAME source.
    const sourceFile = uploadedFileRef.current || (isSequel ? lastSourceFileRef.current : null);
    const sourceText = isSequel ? (lastSourceTextRef.current || inputText) : inputText;

    // Validate input: either a source file or pasted text (min 5 chars).
    // Continue resumes existing output so it needs no fresh source.
    if (!isContinue && !sourceFile && (!sourceText || sourceText.trim().length < 5)) {
      toast({
        title: "Source text required",
        description: isSequel
          ? "The original source text isn't available. Paste it again to generate a sequel."
          : "Please provide a topic or text (at least 5 characters) or upload a file",
        variant: "destructive",
      });
      return;
    }

    // Validate at least one thinker is selected
    if (!selectedAuthor1 || selectedAuthor1 === 'none') {
      toast({
        title: "Thinker required",
        description: "Please select at least the first thinker",
        variant: "destructive",
      });
      return;
    }

    const wordLength = parseInt(wordLengthInput) || 1500;
    if (wordLength < 100 || wordLength > 50000) {
      toast({
        title: "Invalid word length",
        description: "Please enter a number between 100 and 50,000",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    setCanContinue(false);

    // In continue mode we keep the existing output and append to it.
    let accumulatedText = isContinue ? dialogue : '';
    if (!isContinue) {
      setDialogue('');
      setWordCount(0);
    }

    const selectedIds = [selectedAuthor1, selectedAuthor2, selectedAuthor3, selectedAuthor4]
      .filter(id => id && id !== 'none');
    const participantLabels = selectedIds.map(id =>
      id === 'everyman' ? 'Everyman' : (figures.find(f => f.id === id)?.name || 'Author')
    );
    const author1 = figures.find(f => f.id === selectedAuthor1);

    // Reuse the same popup when continuing so output stays in one place.
    const dialoguePopupId = isContinue && dialoguePopupIdRef.current
      ? dialoguePopupIdRef.current
      : `dialogue-${Date.now()}`;
    dialoguePopupIdRef.current = dialoguePopupId;
    abortControllerRef.current = new AbortController();
    registerPopup({
      id: dialoguePopupId,
      title: `Dialogue: ${participantLabels.join(" & ") || "Author"}`,
      content: accumulatedText,
      isGenerating: true,
      filename: `dialogue_${author1?.name.replace(/\s+/g, '_') || 'author'}.txt`,
      onStop: () => abortControllerRef.current?.abort(),
    });

    // Track whether the server signalled completion. If the stream ends
    // without it (stall / dropped connection), we offer "Continue".
    let receivedDone = false;

    try {
      const formData = new FormData();

      // If a source file is available, send it; otherwise send text.
      // Remember the file so a later sequel can reuse the same source.
      if (sourceFile) {
        formData.append('file', sourceFile);
        lastSourceFileRef.current = sourceFile;
      } else {
        formData.append('text', sourceText || 'Continue the dialogue');
        // Snapshot the text source so a later sequel reuses the same source text.
        if (!isContinue && sourceText) {
          lastSourceTextRef.current = sourceText;
        }
      }

      if (customInstructions.trim()) {
        formData.append('customInstructions', customInstructions);
      }

      formData.append('wordLength', wordLength.toString());
      formData.append('elevenLabsMode', String(elevenLabsMode));

      // Resume from existing partial output
      if (isContinue) {
        formData.append('existingText', accumulatedText);
      }

      // Write a sequel that builds on the previously generated dialogue
      if (isSequel) {
        formData.append('priorDialogue', priorDialogueText);
      }

      // Send thinker selections (up to four)
      if (selectedAuthor1 && selectedAuthor1 !== 'none') {
        formData.append('authorId1', selectedAuthor1);
      }
      if (selectedAuthor2 && selectedAuthor2 !== 'none') {
        formData.append('authorId2', selectedAuthor2);
      }
      if (selectedAuthor3 && selectedAuthor3 !== 'none') {
        formData.append('authorId3', selectedAuthor3);
      }
      if (selectedAuthor4 && selectedAuthor4 !== 'none') {
        formData.append('authorId4', selectedAuthor4);
      }

      const response = await fetch('/api/dialogue-creator', {
        method: 'POST',
        body: formData,
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate dialogue');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No reader available');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);

              if (parsed.content) {
                accumulatedText += parsed.content;
                setDialogue(accumulatedText);
                updatePopup(dialoguePopupId, { content: accumulatedText });
              }

              if (parsed.done && parsed.wordCount) {
                receivedDone = true;
                setWordCount(parsed.wordCount);
                updatePopup(dialoguePopupId, { isGenerating: false });
              }

              if (parsed.error) {
                throw new Error(parsed.error);
              }
            } catch (e) {
              // Ignore JSON parse errors for non-JSON lines
            }
          }
        }
      }

      if (receivedDone) {
        toast({
          title: isContinue ? "Dialogue continued" : isSequel ? "Sequel generated" : "Dialogue generated",
          description: `${accumulatedText.split(/\s+/).filter(Boolean).length} words total`,
        });
        // Clear uploaded file after a fully successful generation
        uploadedFileRef.current = null;
        setUploadedFileName('');
        setUploadedFileSize(0);
      } else {
        // Stream ended without a completion signal -> stalled mid-generation
        setCanContinue(accumulatedText.trim().length > 0);
        toast({
          title: "Generation stalled",
          description: "Output is incomplete. Click \"Continue Generation\" to pick up where it left off.",
          variant: "destructive",
        });
      }

    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted) console.error('Error generating dialogue:', error);
      // Offer continue whenever we have partial output to resume from
      const hasPartial = accumulatedText.trim().length > 0;
      setCanContinue(hasPartial);
      toast({
        title: aborted
          ? "Generation stopped"
          : (hasPartial ? "Generation interrupted" : "Generation failed"),
        description: aborted
          ? (hasPartial ? "Stopped. Click \"Continue Generation\" to resume from here." : "Generation was stopped.")
          : (hasPartial
            ? "Output is incomplete. Click \"Continue Generation\" to resume."
            : (error instanceof Error ? error.message : "Unknown error occurred")),
        variant: aborted ? "default" : "destructive",
      });
      updatePopup(dialoguePopupId, { isGenerating: false });
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
      updatePopup(dialoguePopupId, { isGenerating: false });
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(dialogue);
      toast({
        title: "Copied!",
        description: "Dialogue copied to clipboard",
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Could not copy to clipboard",
        variant: "destructive",
      });
    }
  };

  const handleDownload = () => {
    const blob = new Blob([dialogue], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dialogue_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: "Downloaded",
      description: "Dialogue saved as text file",
    });
  };

  const handleDelete = () => {
    if (window.confirm('Are you sure you want to delete this dialogue?')) {
      setDialogue('');
      setWordCount(0);
      setCanContinue(false);
      toast({
        title: "Deleted",
        description: "Dialogue cleared",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold flex items-center gap-2">
          <MessageSquare className="w-8 h-8" />
          Dialogue Creator
        </h2>
        <p className="text-muted-foreground mt-2">
          Transform non-fiction into authentic philosophical dialogue.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Input</CardTitle>
          <CardDescription>
            Enter a topic (e.g., "The merits of rationalism") or paste/upload a full text for transformation
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => {
            const newMode = v as 'paste' | 'upload';
            setMode(newMode);
            // Clear uploaded file when switching to paste mode
            if (newMode === 'paste') {
              handleClearFile();
            }
          }}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="paste" data-testid="tab-paste">Paste Text</TabsTrigger>
              <TabsTrigger value="upload" data-testid="tab-upload">Upload File</TabsTrigger>
            </TabsList>

            <TabsContent value="paste" className="space-y-4">
              <div>
                <Label htmlFor="input-text">Topic or Text</Label>
                <Textarea
                  id="input-text"
                  data-testid="textarea-input"
                  placeholder="Enter a topic (e.g., 'Discuss the merits of rationalism') or paste a full text..."
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  rows={8}
                  className="mt-2"
                />
                <p className="text-sm text-muted-foreground mt-1">
                  {inputText.length} characters
                </p>
              </div>
            </TabsContent>

            <TabsContent value="upload" className="space-y-4">
              <div>
                <Label>Upload File</Label>
                <DragDropUpload
                  accept=".txt,.pdf,.doc,.docx"
                  maxSizeBytes={5 * 1024 * 1024}
                  onFileAccepted={handleFileAccepted}
                  onValidationError={handleValidationError}
                  onClear={handleClearFile}
                  currentFileName={uploadedFileName}
                  currentFileSize={uploadedFileSize}
                  data-testid="drag-drop-upload"
                  className="mt-2"
                />
              </div>
              {inputText && uploadedFileName && (
                <div>
                  <Label>Loaded Text Preview</Label>
                  <Textarea
                    value={inputText.slice(0, 500)}
                    readOnly
                    rows={6}
                    className="mt-2 font-mono text-sm"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    {inputText.length} characters loaded
                  </p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="author-select-1">
                First Thinker (Required)
              </Label>
              <Select
                value={selectedAuthor1}
                onValueChange={setSelectedAuthor1}
              >
                <SelectTrigger
                  id="author-select-1"
                  data-testid="select-author-1"
                  className="mt-2"
                >
                  <SelectValue placeholder="Select first thinker..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Select Thinker --</SelectItem>
                  {figures.map((figure) => (
                    <SelectItem key={figure.id} value={figure.id}>
                      {getDisplayName(figure.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="author-select-2">
                Second Thinker
              </Label>
              <Select
                value={selectedAuthor2}
                onValueChange={setSelectedAuthor2}
              >
                <SelectTrigger
                  id="author-select-2"
                  data-testid="select-author-2"
                  className="mt-2"
                >
                  <SelectValue placeholder="Select second thinker..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Select Thinker --</SelectItem>
                  <SelectItem value="everyman">Everyman (Non-philosopher)</SelectItem>
                  {figures.map((figure) => (
                    <SelectItem key={figure.id} value={figure.id}>
                      {getDisplayName(figure.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="author-select-3">
                Third Thinker (Optional)
              </Label>
              <Select
                value={selectedAuthor3}
                onValueChange={setSelectedAuthor3}
              >
                <SelectTrigger
                  id="author-select-3"
                  data-testid="select-author-3"
                  className="mt-2"
                >
                  <SelectValue placeholder="Select third thinker..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Select Thinker --</SelectItem>
                  <SelectItem value="everyman">Everyman (Non-philosopher)</SelectItem>
                  {figures.map((figure) => (
                    <SelectItem key={figure.id} value={figure.id}>
                      {getDisplayName(figure.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="author-select-4">
                Fourth Thinker (Optional)
              </Label>
              <Select
                value={selectedAuthor4}
                onValueChange={setSelectedAuthor4}
              >
                <SelectTrigger
                  id="author-select-4"
                  data-testid="select-author-4"
                  className="mt-2"
                >
                  <SelectValue placeholder="Select fourth thinker..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Select Thinker --</SelectItem>
                  <SelectItem value="everyman">Everyman (Non-philosopher)</SelectItem>
                  {figures.map((figure) => (
                    <SelectItem key={figure.id} value={figure.id}>
                      {getDisplayName(figure.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Select up to four thinkers to dialogue with each other. Choose "Everyman" in any slot for a non-philosopher participant. Only the first thinker is required.
          </p>

          <div>
            <Label htmlFor="custom-instructions">Optional Customization</Label>
            <Textarea
              id="custom-instructions"
              data-testid="textarea-customization"
              placeholder="Optional: Specify tone, character types, focus areas, or any other instructions..."
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              rows={3}
              className="mt-2"
            />
            <p className="text-sm text-muted-foreground mt-1">
              e.g., "Make it more confrontational" or "Focus on the psychological aspects"
            </p>
          </div>

          <div>
            <Label htmlFor="word-length-input">Dialogue Length (100 - 50,000 words)</Label>
            <Input
              id="word-length-input"
              type="number"
              min={100}
              max={50000}
              value={wordLengthInput}
              onChange={(e) => setWordLengthInput(e.target.value)}
              placeholder="Enter desired word count..."
              className="mt-2"
              data-testid="input-word-length"
            />
            <p className="text-sm text-muted-foreground mt-1">
              {parseInt(wordLengthInput) > 2000 
                ? `Will be generated in ${Math.ceil(parseInt(wordLengthInput) / 2000)} chapters using coherence system`
                : "Single generation"
              }
            </p>
          </div>

          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
            <div className="space-y-0.5">
              <Label htmlFor="elevenlabs-toggle-dialogue" className="text-sm font-medium">
                ElevenLabs-Ready Output
              </Label>
              <p className="text-xs text-muted-foreground">
                Format as Speaker 1 / Speaker 2 lines, ready to paste into ElevenLabs Studio.
              </p>
            </div>
            <Switch
              id="elevenlabs-toggle-dialogue"
              checked={elevenLabsMode}
              onCheckedChange={setElevenLabsMode}
              data-testid="toggle-elevenlabs-dialogue"
            />
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isGenerating || !inputText || inputText.trim().length < 5 || !selectedAuthor1 || selectedAuthor1 === 'none'}
            className="w-full"
            size="lg"
            data-testid="button-generate"
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating Dialogue...
              </>
            ) : (
              <>
                <MessageSquare className="mr-2 h-4 w-4" />
                Generate Dialogue
              </>
            )}
          </Button>

          {isGenerating && (
            <Button
              onClick={handleStop}
              variant="destructive"
              className="w-full mt-2"
              size="lg"
              data-testid="button-stop"
            >
              <Square className="mr-2 h-4 w-4" />
              Stop Generating
            </Button>
          )}

          {canContinue && !isGenerating && (
            <Button
              onClick={handleContinue}
              variant="secondary"
              className="w-full mt-2"
              size="lg"
              data-testid="button-continue"
            >
              <MessageSquare className="mr-2 h-4 w-4" />
              Continue Generation
            </Button>
          )}

          {dialogue.trim() && !isGenerating && (
            <>
              <Button
                onClick={handleSequel}
                variant="outline"
                className="w-full mt-2"
                size="lg"
                data-testid="button-sequel"
              >
                <BookOpen className="mr-2 h-4 w-4" />
                Generate Sequel
              </Button>
              <p className="text-xs text-muted-foreground mt-1 text-center">
                Writes a follow-up to the dialogue above on the same source text. Adjust the thinkers first if you'd like a different cast.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {dialogue && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Dialogue Output</CardTitle>
                <CardDescription>
                  {wordCount > 0 ? `${wordCount} words generated` : 'Generated dialogue'}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  data-testid="button-download"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  data-testid="button-copy"
                >
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  data-testid="button-delete"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="prose dark:prose-invert max-w-none">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed bg-muted/50 p-4 rounded-lg text-foreground" data-testid="text-dialogue-output">
                {dialogue}
              </pre>
            </div>
            <ElevenLabsOutput rawText={dialogue} filename="dialogue.txt" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
