import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles, 
  Upload, 
  BookOpen, 
  Plus, 
  Trash2, 
  Download, 
  Save, 
  Send, 
  ChevronRight,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  X,
  PlusCircle,
  Pencil,
  Layers,
  FileDown,
  FileType,
  Zap,
  Check,
  Image as ImageIcon,
  Settings,
  Shield,
  Brain
} from 'lucide-react';
import { generateQuestionsFromPrompt, analyzeCurriculum, extractQuestionsFromFile, analyzePaperTemplate, reinitializeAI, addQuestionsToMemory } from '../services/geminiService';
import { savePaperToDB, getPapersForFaculty, saveTemplate, getTemplates, deleteTemplate, deletePaper, subscribeToPapersForFaculty } from '../services/mockServices';
import { exportToPDF, exportToDocx, exportToTxt } from '../services/exportService';
import { SubmitPaperForm } from '../components/SubmitPaperForm';
import { questionMemory } from '../services/questionMemory';
import { Question, QuestionPaper, PaperStatus, QuestionType, Difficulty, ViewType, PaperTemplate } from '../types';
import { useAuth } from '../src/AuthContext';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set worker source globally
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const QuestionImage: React.FC<{ 
  question: Question; 
  source: { data: string; type: string } | null;
  onCrop?: (url: string) => void;
}> = ({ question, source, onCrop }) => {
    const [croppedUrl, setCroppedUrl] = useState<string | null>(null);
    const canvasRef = React.useRef<HTMLCanvasElement>(null);

    useEffect(() => {
      if (question.imageUrl) {
        setCroppedUrl(question.imageUrl);
        return;
      }
      
      if (!question.boundingBox || !source) {
        console.log("QuestionImage: Missing boundingBox or source", { hasBB: !!question.boundingBox, hasSource: !!source });
        return;
      }

      const cropImage = async () => {
        try {
          const [ymin, xmin, ymax, xmax] = question.boundingBox!;
          const pageNum = question.pageNumber || 1;
          
          console.log("QuestionImage: Cropping", { ymin, xmin, ymax, xmax, pageNum, type: source.type });

          if (source.type.startsWith('image/')) {
            const img = new Image();
            img.src = source.data;
            img.onload = () => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              const ctx = canvas.getContext('2d');
              if (!ctx) return;

              const width = img.width * (xmax - xmin) / 1000;
              const height = img.height * (ymax - ymin) / 1000;
              const sx = img.width * xmin / 1000;
              const sy = img.height * ymin / 1000;

              console.log("QuestionImage: Image dimensions", { width, height, sx, sy, imgW: img.width, imgH: img.height });

              canvas.width = width;
              canvas.height = height;
              ctx.drawImage(img, sx, sy, width, height, 0, 0, width, height);
              const url = canvas.toDataURL();
              setCroppedUrl(url);
              if (onCrop && !question.imageUrl) {
                onCrop(url);
              }
            };
          } else if (source.type === 'application/pdf') {
            // PDF cropping logic using pdfjs-dist
            const loadingTask = pdfjs.getDocument(source.data);
            const pdf = await loadingTask.promise;
            
            console.log("QuestionImage: PDF loaded", { numPages: pdf.numPages });
            
            // Ensure page number is within range
            const targetPage = Math.min(Math.max(1, pageNum), pdf.numPages);
            const page = await pdf.getPage(targetPage);
            
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) return;

            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: context, viewport, canvas }).promise;

            const finalCanvas = canvasRef.current;
            if (!finalCanvas) return;
            const finalCtx = finalCanvas.getContext('2d');
            if (!finalCtx) return;

            const width = viewport.width * (xmax - xmin) / 1000;
            const height = viewport.height * (ymax - ymin) / 1000;
            const sx = viewport.width * xmin / 1000;
            const sy = viewport.height * ymin / 1000;

            console.log("QuestionImage: PDF viewport dimensions", { width, height, sx, sy, vW: viewport.width, vH: viewport.height });

            finalCanvas.width = width;
            finalCanvas.height = height;
            finalCtx.drawImage(canvas, sx, sy, width, height, 0, 0, width, height);
            const url = finalCanvas.toDataURL();
            setCroppedUrl(url);
            if (onCrop && !question.imageUrl) {
              onCrop(url);
            }
          }
        } catch (err) {
          console.error("QuestionImage: Crop error", err);
        }
      };

      cropImage();
    }, [question, source, onCrop]);

    if (!question.hasImage) return null;

    return (
      <div className="mt-4 space-y-2">
        <canvas ref={canvasRef} className="hidden" />
        {croppedUrl ? (
          <div className="rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white">
            <img src={croppedUrl} alt="Extracted Diagram" className="w-full h-auto max-h-[300px] object-contain" />
          </div>
        ) : (!question.boundingBox || !source) ? (
          <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col items-center justify-center gap-3 text-slate-400">
            <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center">
              <ImageIcon className="w-5 h-5" />
            </div>
            <p className="text-[10px] font-medium italic text-center max-w-[200px]">
              Visual context detected but exact coordinates were not provided by AI.
            </p>
          </div>
        ) : (
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col gap-2 animate-pulse">
            <div className="h-4 bg-slate-200 rounded w-1/3" />
            <div className="h-32 bg-slate-200 rounded" />
          </div>
        )}
      </div>
    );
  };

interface FacultyDashboardProps {
    userId: string;
    userName: string;
    currentView: ViewType;
    onNavigate?: (view: ViewType) => void;
}

const FacultyDashboard: React.FC<FacultyDashboardProps> = ({ userId, userName, currentView, onNavigate }) => {
  const { department } = useAuth();
  const [selectedDepartment, setSelectedDepartment] = useState(department || '');
  const [activeTab, setActiveTab] = useState<'prompt' | 'upload' | 'curriculum' | 'settings'>('prompt');
  const [prompt, setPrompt] = useState('');
  const [customApiKey, setCustomApiKey] = useState(localStorage.getItem('CUSTOM_GEMINI_API_KEY') || '');
  const [generatedQuestions, setGeneratedQuestions] = useState<Question[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paperTitle, setPaperTitle] = useState('');
  const [examName, setExamName] = useState('');
  const [instituteName, setInstituteName] = useState('Sagar Institute of Science and Technology');
  const [subjectName, setSubjectName] = useState('');
  const [subjectCode, setSubjectCode] = useState('');
  const [examDate, setExamDate] = useState('');
  const [maxMarks, setMaxMarks] = useState('');
  const [enrollmentNo, setEnrollmentNo] = useState('');
  const [instructions, setInstructions] = useState('');
  const [paperFormat, setPaperFormat] = useState('MST-I_SISTec');
  const [isSaved, setIsSaved] = useState(false);
  const [saveMessage, setSaveMessage] = useState('Submitted for approval successfully!');
  const [hasSelectedKey, setHasSelectedKey] = useState(true);
  
  const [extractedQuestions, setExtractedQuestions] = useState<Question[]>([]);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [customQuestion, setCustomQuestion] = useState<Partial<Question>>({ type: QuestionType.SHORT_ANSWER, difficulty: Difficulty.MEDIUM, marks: 2 });

  const [myPapers, setMyPapers] = useState<QuestionPaper[]>([]);
  const [submittedPapers, setSubmittedPapers] = useState<QuestionPaper[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [templates, setTemplates] = useState<PaperTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [paperToDelete, setPaperToDelete] = useState<string | null>(null);

  const loadPaperForEditing = (paper: QuestionPaper) => {
    setPaperTitle(paper.title);
    setExamName(paper.examName || '');
    setSubjectName(paper.subjectName || '');
    setSubjectCode(paper.courseCode || '');
    setExamDate(paper.examDate || '');
    setMaxMarks(paper.maxMarks?.toString() || '');
    setInstructions(paper.instructions || '');
    setPaperFormat(paper.format || 'Standard');
    setSelectedTemplateId(paper.templateId || '');
    setLogoUrl(paper.logoUrl || null);
    setGeneratedQuestions(paper.questions);
    setActiveTab('prompt');
    onNavigate?.('dashboard');
  };

  const confirmDeletePaper = async () => {
    if (paperToDelete) {
      try {
        await deletePaper(paperToDelete);
      } catch (error) {
        console.error("Failed to delete paper:", error);
      } finally {
        setPaperToDelete(null);
      }
    }
  };
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [templateCounts, setTemplateCounts] = useState<{ mcqCount: number; shortCount: number; longCount: number } | null>({ mcqCount: 12, shortCount: 6, longCount: 4 });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [originalFile, setOriginalFile] = useState<{ data: string; type: string } | null>(null);

  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    if (department && !selectedDepartment) {
      setSelectedDepartment(department);
    }
  }, [department]);

  useEffect(() => {
    const checkKeySelection = async () => {
      // @ts-ignore
      if (window.aistudio && window.aistudio.hasSelectedApiKey) {
        // @ts-ignore
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasSelectedKey(selected);
      }
    };
    checkKeySelection();
  }, []);

  const handleSelectKey = async () => {
    // @ts-ignore
    if (window.aistudio && window.aistudio.openSelectKey) {
      // @ts-ignore
      await window.aistudio.openSelectKey();
      setHasSelectedKey(true);
      setError(null);
    }
  };

  useEffect(() => {
      if (!userId) return;
      let unsubscribe: () => void;
      if (currentView === 'my_papers') {
          unsubscribe = subscribeToPapersForFaculty(userId, (papers) => {
              setMyPapers(papers);
              setHistoryLoading(false);
          });
      } else if (currentView === 'templates' || currentView === 'dashboard') {
          loadTemplates();
      } else if (currentView === 'submit_paper') {
          unsubscribe = subscribeToPapersForFaculty(userId, (papers) => {
              setSubmittedPapers(papers);
          });
      }
      return () => {
          if (unsubscribe) unsubscribe();
      };
  }, [currentView, userId]);

  // Check for API key on component mount
  useEffect(() => {
    const storedApiKey = localStorage.getItem('CUSTOM_GEMINI_API_KEY');
    if (storedApiKey) {
      setCustomApiKey(storedApiKey);
      setHasSelectedKey(true);
    } else {
      setHasSelectedKey(false);
    }
  }, []);

  useEffect(() => {
      if (selectedTemplateId) {
          const template = templates.find(t => t.id === selectedTemplateId);
          if (template) {
              analyzePaperTemplate(template.fileUrl, 'application/pdf').then(counts => {
                  // Override for SISTec MST-I format as requested by user
                  if (template.name.includes('MST-I_SISTec')) {
                      setTemplateCounts({
                          mcqCount: 12,
                          shortCount: 6,
                          longCount: 4
                      });
                  } else if (template.name.includes('MST -II format Dec 2025')) {
                      setTemplateCounts({
                          mcqCount: 18,
                          shortCount: 9,
                          longCount: 3
                      });
                  } else {
                      setTemplateCounts(counts);
                  }
              });
          }
      } else if (paperFormat === 'MST-I_SISTec') {
          setTemplateCounts({
              mcqCount: 12,
              shortCount: 6,
              longCount: 4
          });
      } else if (paperFormat === 'MST -II format Dec 2025') {
          setTemplateCounts({
              mcqCount: 18,
              shortCount: 9,
              longCount: 3
          });
      } else {
          setTemplateCounts(null);
      }
  }, [selectedTemplateId, templates, paperFormat]);

  const loadTemplates = async () => {
      setTemplateLoading(true);
      const data = await getTemplates(userId);
      setTemplates(data);
      setTemplateLoading(false);
  };

  const ApiKeyBanner = () => {
    if (hasSelectedKey) return null;
    return (
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-amber-50 border border-amber-200 p-4 rounded-2xl flex items-center justify-between gap-4 mb-6"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center text-amber-600">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-bold text-amber-900 text-sm">AI Quota Optimization</h4>
            <p className="text-amber-700 text-xs">To avoid "Quota Exceeded" errors and ensure faster processing, please select your own Gemini API key.</p>
          </div>
        </div>
        <button 
          onClick={handleSelectKey}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition-all shadow-sm"
        >
          Select API Key
        </button>
      </motion.div>
    );
  };

  const handleSaveApiKey = () => {
    if (customApiKey) {
      // Validate API key format (Gemini keys start with "AIza")
      if (!customApiKey.trim().startsWith('AIza')) {
        setError('Invalid API key format. Gemini API keys should start with "AIza"');
        return;
      }
      
      // Validate API key length (should be around 39 characters)
      if (customApiKey.trim().length < 30) {
        setError('API key appears to be too short. Please check your Gemini API key.');
        return;
      }
      
      localStorage.setItem('CUSTOM_GEMINI_API_KEY', customApiKey.trim());
      // Re-initialize AI service with new key
      reinitializeAI();
      setHasSelectedKey(true);
      setIsSaved(true);
      setSaveMessage('API Key saved successfully! You can now use AI features without quota limits.');
      setError(null); // Clear any existing errors
      setTimeout(() => setIsSaved(false), 3000);
    } else {
      localStorage.removeItem('CUSTOM_GEMINI_API_KEY');
      setHasSelectedKey(false);
      setSaveMessage('API Key removed. You will need to add a new key to use AI features.');
      setTimeout(() => setIsSaved(false), 3000);
    }
  };

  const checkApiKey = () => {
    // Only check for user-provided API key
    const apiKey = localStorage.getItem('CUSTOM_GEMINI_API_KEY');
    if (!apiKey) {
      setError("API quota exceeded. Please add your own Gemini API key in Settings to continue using AI features.");
      setHasSelectedKey(false);
      return false;
    }
    setHasSelectedKey(true);
    return true;
  };

  const handlePromptGenerate = async () => {
    if (!prompt) return;
    if (!checkApiKey()) return;
    
    setIsLoading(true);
    setLoadingMessage('Analyzing your prompt and generating questions...');
    try {
      // Extract count if mentioned (e.g., "10 questions")
      const countMatch = prompt.match(/(\d+)\s*(?:questions|ques|q)/i);
      const count = countMatch ? parseInt(countMatch[1]) : 5;

      // Extract marks if mentioned (e.g., "42 marks")
      const marksMatch = prompt.match(/(\d+)\s*(?:marks|mark|pts|points)/i);
      const targetMarks = marksMatch ? parseInt(marksMatch[1]) : (maxMarks ? parseInt(maxMarks) : undefined);

      const contextPrompt = `
        Subject: ${subjectName || 'General'}
        Subject Code: ${subjectCode || 'N/A'}
        Context: ${prompt}
      `;
      
      // Find selected template if any
      const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

      setLoadingMessage('AI is crafting your questions...');
      const questions = await generateQuestionsFromPrompt(
        contextPrompt, 
        count, 
        Difficulty.MEDIUM, 
        targetMarks,
        selectedTemplate?.fileUrl,
        selectedTemplate?.fileUrl ? 'application/pdf' : undefined,
        templateCounts || undefined,
        subjectName
      );
      
      setExtractedQuestions(questions);
      setLoadingMessage('Questions generated successfully!');
      
      // Auto-set paper title if empty
      if (!paperTitle && subjectName) {
        setPaperTitle(`${subjectName} - ${new Date().getFullYear()}`);
      }
      
      // Sync maxMarks if extracted from prompt
      if (targetMarks && !maxMarks) {
        setMaxMarks(targetMarks.toString());
      }
      setTimeout(() => setLoadingMessage(''), 2000);
    } catch (e: any) {
      console.error(e);
      if (e.message?.includes("429") || e.message?.toLowerCase().includes("quota")) {
        setError("API Quota exceeded. Please select your own API key to continue.");
        setHasSelectedKey(false);
      } else {
        setError("Failed to generate questions. Please check your API key and try again.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const updateQuestionImage = (questionId: string, imageUrl: string) => {
    setExtractedQuestions(prev => prev.map(q => q.id === questionId ? { ...q, imageUrl } : q));
    setGeneratedQuestions(prev => prev.map(q => q.id === questionId ? { ...q, imageUrl } : q));
  };

  const handleImageUpload = (questionId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (JPG, PNG, etc.)');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image file should be less than 5MB');
      return;
    }

    // Convert image to data URL
    const reader = new FileReader();
    reader.onload = (e) => {
      const imageUrl = e.target?.result as string;
      
      // Update the main question with uploaded image
      setExtractedQuestions(prev => prev.map(q => 
        q.id === questionId ? { 
          ...q, 
          imageUrl, 
          hasImage: true,
          imageDescription: `Uploaded image: ${file.name}`
        } : q
      ));
      
      setGeneratedQuestions(prev => prev.map(q => 
        q.id === questionId ? { 
          ...q, 
          imageUrl, 
          hasImage: true,
          imageDescription: `Uploaded image: ${file.name}`
        } : q
      ));
    };
    reader.readAsDataURL(file);
  };

  const handleAlternativeImageUpload = (questionId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (JPG, PNG, etc.)');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image file should be less than 5MB');
      return;
    }

    // Convert image to data URL
    const reader = new FileReader();
    reader.onload = (e) => {
      const imageUrl = e.target?.result as string;
      
      // Update the alternative question (part b) with uploaded image
      setExtractedQuestions(prev => prev.map(q => 
        q.id === questionId ? { 
          ...q, 
          alternativeImageUrl: imageUrl,
          hasAlternativeImage: true,
          alternativeImageDescription: `Uploaded image for part b: ${file.name}`
        } : q
      ));
      
      setGeneratedQuestions(prev => prev.map(q => 
        q.id === questionId ? { 
          ...q, 
          alternativeImageUrl: imageUrl,
          hasAlternativeImage: true,
          alternativeImageDescription: `Uploaded image for part b: ${file.name}`
        } : q
      ));
    };
    reader.readAsDataURL(file);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'paper' | 'curriculum' | 'template') => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      
      if (type !== 'curriculum' && !checkApiKey()) return;
      
      setIsLoading(true);
      setLoadingMessage(`Uploading and analyzing ${file.name}...`);
      
      try {
        // Validate file type
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
        if (!allowedTypes.includes(file.type)) {
          throw new Error('Invalid file type. Please upload a PDF or Image file (JPEG/PNG).');
        }

        // Validate file size (10MB limit)
        const maxSize = 10 * 1024 * 1024; // 10MB in bytes
        if (file.size > maxSize) {
          throw new Error('File size exceeds 10MB limit. Please upload a smaller file.');
        }

        if (type === 'curriculum') {
          setLoadingMessage('Extracting topics from curriculum...');
          // For curriculum, we still use a mock text for now or we could extract text
          const topics = await analyzeCurriculum("Mock curriculum text from " + file.name);
          const contextPrompt = `
            Subject: ${subjectName || 'General'}
            Subject Code: ${subjectCode || 'N/A'}
            Topics: ${topics.join(', ')}
          `;
          setLoadingMessage('Generating questions based on curriculum topics...');
          const questions = await generateQuestionsFromPrompt(contextPrompt, 5, undefined, undefined, undefined, undefined, undefined, subjectName);
          setExtractedQuestions(questions);
          setLoadingMessage('Questions generated from curriculum!');
        } else if (type === 'template') {
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = reader.result as string;
            
            setLoadingMessage('Analyzing template structure...');
            // Analyze template counts
            const counts = await analyzePaperTemplate(base64, file.type);
            console.log('Detected Template Counts:', counts);
            setTemplateCounts(counts);

            const newTemplate: PaperTemplate = {
              id: `template-${Date.now()}`,
              name: file.name.replace('.pdf', ''),
              fileUrl: base64,
              uploadedAt: new Date().toISOString(),
              facultyId: userId
            };
            await saveTemplate(newTemplate);
            loadTemplates();
            setIsLoading(false);
            setLoadingMessage('Template saved and analyzed!');
            setTimeout(() => setLoadingMessage(''), 2000);
          };
          reader.readAsDataURL(file);
          return;
        } else {
          // Read file as base64
          const reader = new FileReader();
          reader.onload = async () => {
            const fullBase64 = reader.result as string;
            const base64 = fullBase64.split(',')[1];
            setOriginalFile({ data: fullBase64, type: file.type });
            try {
              setLoadingMessage('AI is performing OCR and extracting questions...');
              const result = await extractQuestionsFromFile(base64, file.type, templateCounts || undefined);
              setExtractedQuestions(result.questions);
              // Questions will only be added when explicitly selected by user
              
              if (result.metadata) {
                if (result.metadata.instituteName) setInstituteName(result.metadata.instituteName);
                if (result.metadata.examName) setExamName(result.metadata.examName);
                if (result.metadata.subjectName) setSubjectName(result.metadata.subjectName);
                if (result.metadata.subjectCode) setSubjectCode(result.metadata.subjectCode);
                if (result.metadata.department) setSelectedDepartment(result.metadata.department);
                if (result.metadata.maxMarks) setMaxMarks(String(result.metadata.maxMarks));
                if (result.metadata.instructions) setInstructions(result.metadata.instructions);
              }
              setLoadingMessage('Questions extracted successfully!');
              setTimeout(() => setLoadingMessage(''), 2000);
            } catch (err: any) {
              console.error(err);
              if (err.message?.includes("429") || err.message?.toLowerCase().includes("quota")) {
                setError("API Quota exceeded. Please select your own API key to continue.");
                setHasSelectedKey(false);
              } else {
                setError("Failed to extract questions. Please check your API key and ensure the file is a valid PDF or Image.");
              }
              setTimeout(() => setError(null), 5000);
            } finally {
              setIsLoading(false);
            }
          };
          reader.readAsDataURL(file);
          return; // Exit early as reader is async
        }
      } catch (err) {
        console.error(err);
        setError("An unexpected error occurred.");
      } finally {
        if (type === 'curriculum') {
          setIsLoading(false);
          setTimeout(() => setLoadingMessage(''), 2000);
        }
      }
    }
  };

  const toggleSelectAll = () => {
    if (selectedQuestionIds.size === extractedQuestions.length) {
      setSelectedQuestionIds(new Set());
    } else {
      setSelectedQuestionIds(new Set(extractedQuestions.map(q => q.id)));
    }
  };

  const toggleQuestionSelection = (id: string) => {
    const newSelected = new Set(selectedQuestionIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedQuestionIds(newSelected);
  };

  const addSelectedQuestions = () => {
    const selected = extractedQuestions.filter(q => selectedQuestionIds.has(q.id));
    setGeneratedQuestions(prev => [...prev, ...selected]);
    setExtractedQuestions([]);
    setSelectedQuestionIds(new Set());
  };

  const handleAddCustomQuestion = () => {
      if (!customQuestion.text) return;
      
      const newQ: Question = {
          id: `custom-${Date.now()}`,
          text: customQuestion.text,
          type: customQuestion.type || QuestionType.SHORT_ANSWER,
          difficulty: customQuestion.difficulty || Difficulty.MEDIUM,
          marks: customQuestion.marks || 5,
          correctAnswer: customQuestion.correctAnswer || '',
          section: customQuestion.section || 'Uncategorized',
          sectionTitle: customQuestion.sectionTitle || 'Uncategorized',
          alternativeText: customQuestion.type === QuestionType.LONG_ANSWER ? customQuestion.alternativeText || '[Alternative Question Placeholder]' : undefined,
          alternativeAnswer: customQuestion.type === QuestionType.LONG_ANSWER ? customQuestion.alternativeAnswer || '' : undefined,
          options: customQuestion.type === QuestionType.MCQ ? customQuestion.options || ['A', 'B', 'C', 'D'] : []
      };
      setGeneratedQuestions(prev => [...prev, newQ]);
      setShowAddModal(false);
      setCustomQuestion({ type: QuestionType.SHORT_ANSWER, difficulty: Difficulty.MEDIUM, marks: 2 });
  };

  const handleRemoveQuestion = (id: string) => {
    setGeneratedQuestions(prev => prev.filter(q => q.id !== id));
  };

  const handleUpdateQuestion = (updatedQ: Question) => {
    setGeneratedQuestions(prev => prev.map(q => q.id === updatedQ.id ? updatedQ : q));
    setExtractedQuestions(prev => prev.map(q => q.id === updatedQ.id ? updatedQ : q));
    setEditingQuestion(null);
    setShowEditModal(false);
  };

  const handleSaveForApproval = async () => {
    const finalTitle = paperTitle || subjectName || examName || "Untitled Paper";
    if (generatedQuestions.length === 0) {
        return;
    }
    setIsLoading(true);
    const paper: QuestionPaper = {
        id: `paper-${Date.now()}`,
        title: finalTitle,
        examName,
        courseCode: subjectCode || "CS-TEMP",
        facultyId: userId,
        facultyName: userName,
        createdAt: new Date().toISOString(),
        status: PaperStatus.PENDING_APPROVAL,
        questions: generatedQuestions,
        totalMarks: generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        durationMinutes: 90,
        department: selectedDepartment || null,
        instituteName,
        subjectName,
        examDate,
        maxMarks: Number(maxMarks) || generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        enrollmentNo,
        instructions,
        format: paperFormat,
        templateId: selectedTemplateId || null,
        logoUrl: logoUrl || null
    };
    
    // Add questions to memory only when paper is submitted for approval
    addQuestionsToMemory(subjectName || 'General', generatedQuestions);
    
    await savePaperToDB(paper);
    setIsLoading(false);
    setSaveMessage('Submitted for approval successfully!');
    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
      onNavigate?.('my_papers');
    }, 1500);
  };

  const handleSaveDraft = async () => {
    const finalTitle = paperTitle || subjectName || examName || "Untitled Paper";
    if (generatedQuestions.length === 0) {
        return;
    }
    setIsLoading(true);
    const paper: QuestionPaper = {
        id: `paper-draft-${Date.now()}`,
        title: finalTitle,
        examName,
        courseCode: subjectCode || "CS-TEMP",
        facultyId: userId,
        facultyName: userName,
        createdAt: new Date().toISOString(),
        status: PaperStatus.DRAFT,
        questions: generatedQuestions,
        totalMarks: generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        durationMinutes: 90,
        department: selectedDepartment || null,
        instituteName,
        subjectName,
        examDate,
        maxMarks: Number(maxMarks) || generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        enrollmentNo,
        instructions,
        format: paperFormat,
        templateId: selectedTemplateId || null,
        logoUrl: logoUrl || null
    };
    
    // Add questions to memory when draft is saved
    addQuestionsToMemory(subjectName || 'General', generatedQuestions);
    
    await savePaperToDB(paper);
    setIsLoading(false);
    setSaveMessage('Draft saved successfully!');
    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
      onNavigate?.('my_papers');
    }, 1500);
  };

  const handleExport = (type: 'pdf' | 'docx' | 'txt') => {
    const paper: QuestionPaper = {
        id: `paper-export-${Date.now()}`,
        title: paperTitle || 'Untitled Paper',
        examName: examName || paperTitle,
        instituteName: instituteName || 'Sagar Institute of Science and Technology',
        subjectName: subjectName || paperTitle,
        courseCode: subjectCode || 'N/A',
        facultyId: userId,
        facultyName: userName,
        department: selectedDepartment || 'Computer Science and Engineering',
        createdAt: new Date().toISOString(),
        status: PaperStatus.PENDING_APPROVAL,
        questions: generatedQuestions,
        totalMarks: generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        durationMinutes: 90,
        maxMarks: parseInt(maxMarks) || generatedQuestions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0),
        examDate,
        enrollmentNo,
        instructions,
        format: paperFormat,
        logoUrl: logoUrl || null
    };

    if (type === 'pdf') {
        exportToPDF(paper);
    } else if (type === 'docx') {
        exportToDocx(paper);
    } else {
        exportToTxt(paper);
    }
  };

  if (currentView === 'my_papers') {
      return (
          <div className="space-y-8">
              <ApiKeyBanner />
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold text-slate-900">My Papers</h2>
                  <p className="text-slate-500 mt-1">Manage and track your submitted question papers.</p>
                </div>
              </div>

              {historyLoading ? (
                  <div className="flex flex-col items-center justify-center py-24 gap-4">
                    <div className="w-10 h-10 border-4 border-slate-200 border-t-brand-500 rounded-full animate-spin" />
                    <p className="text-slate-500 font-medium">Loading your papers...</p>
                  </div>
              ) : myPapers.length === 0 ? (
                  <div className="bg-white rounded-3xl p-12 text-center border border-slate-100 shadow-sm">
                    <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
                      <FileText className="w-8 h-8 text-slate-300" />
                    </div>
                    <h3 className="text-xl font-bold mb-2">No papers yet</h3>
                    <p className="text-slate-500 mb-8">Start by creating your first AI-powered question paper.</p>
                    <button className="btn-primary">Create New Paper</button>
                  </div>
              ) : (
                  <div className="grid gap-6">
                      {myPapers.map(p => (
                          <motion.div 
                            key={p.id} 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all group"
                          >
                              <div className="flex justify-between items-start">
                                  <div className="flex gap-4">
                                    <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-brand-50 group-hover:text-brand-500 transition-colors">
                                      <FileText className="w-6 h-6" />
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-lg text-slate-900">{p.title}</h3>
                                        <div className="flex items-center gap-3 mt-1">
                                          <span className="flex items-center gap-1 text-xs font-medium text-slate-400">
                                            <Clock className="w-3 h-3" />
                                            {new Date(p.createdAt).toLocaleDateString()}
                                          </span>
                                          <span className="w-1 h-1 bg-slate-200 rounded-full" />
                                          <span className="text-xs font-medium text-slate-400">{p.questions.length} Questions</span>
                                          <span className="w-1 h-1 bg-slate-200 rounded-full" />
                                          <span className="text-xs font-medium text-slate-400">{p.totalMarks} Marks</span>
                                        </div>
                                    </div>
                                  </div>
                                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider
                                      ${p.status === PaperStatus.APPROVED ? 'bg-emerald-50 text-emerald-600' : 
                                        p.status === PaperStatus.REJECTED ? 'bg-red-50 text-red-600' : 
                                        'bg-amber-50 text-amber-600'}`}>
                                      {p.status?.replace('_', ' ') || p.status}
                                  </span>
                                  <div className="flex gap-2">
                                      {p.status === PaperStatus.DRAFT && (
                                        <button 
                                          onClick={() => loadPaperForEditing(p)}
                                          className="p-2 text-slate-400 hover:text-brand-500 hover:bg-brand-50 rounded-xl transition-all"
                                          title="Edit Paper"
                                        >
                                          <Pencil className="w-5 h-5" />
                                        </button>
                                      )}
                                      <button 
                                        onClick={() => exportToPDF(p)}
                                        className="p-2 text-slate-400 hover:text-brand-500 hover:bg-brand-50 rounded-xl transition-all"
                                        title="Download PDF"
                                      >
                                        <FileDown className="w-5 h-5" />
                                      </button>
                                      <button 
                                        onClick={() => exportToDocx(p)}
                                        className="p-2 text-slate-400 hover:text-brand-500 hover:bg-brand-50 rounded-xl transition-all"
                                        title="Download DOCX"
                                      >
                                        <FileType className="w-5 h-5" />
                                      </button>
                                      <button 
                                        onClick={() => setPaperToDelete(p.id)}
                                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                                        title="Delete Paper"
                                      >
                                        <Trash2 className="w-5 h-5" />
                                      </button>
                                  </div>
                              </div>
                              {p.adminFeedback && (
                                  <div className="mt-6 flex gap-3 bg-red-50/50 p-4 rounded-2xl border border-red-100/50">
                                      <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                                      <div className="text-sm text-red-700">
                                          <span className="font-bold">Admin Feedback:</span> {p.adminFeedback}
                                      </div>
                                  </div>
                              )}
                          </motion.div>
                      ))}
                  </div>
              )}
          </div>
      )
  }

  if (currentView === 'submit_paper') {
    return (
      <div className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold text-slate-900">Submit Question Paper</h2>
          <p className="text-slate-500 mt-1">Select a department and upload a question paper for review.</p>
        </div>
        <div className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm">
          <SubmitPaperForm />
        </div>
        <div className="bg-white rounded-[32px] border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100">
            <h3 className="text-xl font-bold text-slate-900">Submitted Papers</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50">
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Title</th>
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {submittedPapers.map(paper => (
                  <tr key={paper.id} className="hover:bg-slate-50/30 transition-colors">
                    <td className="px-8 py-5 font-bold text-slate-900">{paper.title}</td>
                    <td className="px-8 py-5">
                      <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider border ${
                        paper.status === PaperStatus.APPROVED ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                        paper.status === PaperStatus.REJECTED ? 'bg-red-50 text-red-600 border-red-100' :
                        'bg-amber-50 text-amber-600 border-amber-100'
                      }`}>
                        {paper.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (currentView === 'templates') {
      return (
          <div className="space-y-8">
              <ApiKeyBanner />
              <div>
                <h2 className="text-3xl font-bold text-slate-900">Paper Templates</h2>
                <p className="text-slate-500 mt-1">Upload and manage your institution's official formats.</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="bg-white p-8 rounded-3xl text-center border-2 border-dashed border-slate-200 hover:border-brand-500 transition-colors group relative">
                    <input 
                      type="file" 
                      accept=".pdf" 
                      onChange={(e) => handleFileUpload(e, 'template')} 
                      className="absolute inset-0 opacity-0 cursor-pointer z-10"
                    />
                    <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                      {isLoading ? (
                        <div className="w-8 h-8 border-4 border-slate-200 border-t-brand-500 rounded-full animate-spin" />
                      ) : (
                        <Plus className="w-8 h-8 text-slate-300 group-hover:text-brand-500" />
                      )}
                    </div>
                    <h3 className="text-lg font-bold mb-2">Upload New Format</h3>
                    <p className="text-xs text-slate-500">Upload a PDF header/footer template.</p>
                </div>

                {templates.map(template => (
                  <motion.div 
                    key={template.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col justify-between group"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-12 h-12 bg-brand-50 rounded-2xl flex items-center justify-center text-brand-500">
                        <Layers className="w-6 h-6" />
                      </div>
                      <button 
                        onClick={async () => {
                          await deleteTemplate(template.id);
                          loadTemplates();
                        }}
                        className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-900 mb-1 truncate">{template.name}</h3>
                      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                        Uploaded {new Date(template.uploadedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>

              {templateLoading && templates.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                  <div className="w-8 h-8 border-4 border-slate-200 border-t-brand-500 rounded-full animate-spin" />
                </div>
              )}
          </div>
      )
  }

  return (
    <div className="space-y-10">
      <ApiKeyBanner />
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-slate-900 leading-tight">Create Question Paper</h2>
          <p className="text-slate-500 mt-1">Leverage AI to generate high-quality assessments in seconds.</p>
        </div>
        
        {generatedQuestions.length > 0 && (
          <div className="flex items-center gap-4 bg-white p-2 rounded-2xl border border-slate-100 shadow-sm">
            <div className="px-4 py-2 text-center border-r border-slate-100">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Marks</p>
              <p className="text-xl font-bold text-slate-900">{generatedQuestions.reduce((a, b) => a + Number(b.marks), 0)}</p>
            </div>
            <div className="px-4 py-2 text-center">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Questions</p>
              <p className="text-xl font-bold text-slate-900">{generatedQuestions.length}</p>
            </div>
          </div>
        )}
      </div>

      {/* Creation Mode Tabs */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-2xl text-sm font-bold">
          {error}
        </div>
      )}
      <div className="bg-white rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
        <div className="flex p-2 bg-slate-50/50">
          {[
            { id: 'prompt', label: 'AI Prompt', icon: Sparkles },
            { id: 'upload', label: 'Question Bank', icon: FileText },
            { id: 'curriculum', label: 'Curriculum', icon: BookOpen },
            { id: 'settings', label: 'API Settings', icon: Settings },
          ].map((tab) => (
            <button 
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 flex items-center justify-center gap-2 py-4 text-sm font-bold rounded-2xl transition-all ${activeTab === tab.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-brand-500' : ''}`} />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-8">
            {activeTab === 'settings' && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-8"
              >
                <div className="flex items-center gap-4 mb-2">
                  <div className="w-12 h-12 bg-brand-50 rounded-2xl flex items-center justify-center text-brand-500">
                    <Zap className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Gemini API Configuration</h3>
                    <p className="text-sm text-slate-500">Manually provide an API key to bypass quota limits.</p>
                  </div>
                </div>
                
                <div className="space-y-6 max-w-2xl">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Custom API Key</label>
                    <div className="relative">
                      <input 
                        type="password"
                        className="input-field pr-12"
                        placeholder="Paste your Gemini API key here..."
                        value={customApiKey}
                        onChange={(e) => setCustomApiKey(e.target.value)}
                      />
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300">
                        <Shield className="w-5 h-5" />
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 font-medium">Your key is stored locally in your browser and never sent to our servers.</p>
                  </div>
                  
                  <div className="flex gap-3 pt-4">
                    <button 
                      onClick={handleSaveApiKey}
                      className="btn-primary flex-1"
                    >
                      Save API Key
                    </button>
                    <button 
                      onClick={() => {
                        setCustomApiKey('');
                        localStorage.removeItem('CUSTOM_GEMINI_API_KEY');
                        reinitializeAI(); // Re-initialize AI service
                        setHasSelectedKey(false);
                        setSaveMessage('API Key cleared.');
                        setIsSaved(true);
                        setTimeout(() => setIsSaved(false), 3000);
                      }}
                      className="btn-secondary"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="p-6 bg-slate-50 rounded-[32px] border border-slate-100 flex gap-4">
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-slate-400 shrink-0 shadow-sm">
                      <AlertCircle className="w-5 h-5" />
                    </div>
                    <div className="text-sm text-slate-500 leading-relaxed">
                      <p className="font-bold text-slate-700 mb-1 text-base">How to get an API key?</p>
                      <p className="mb-3">Visit the <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-brand-500 hover:underline font-bold">Google AI Studio</a> to generate a free or paid API key for your project.</p>
                      <ul className="list-disc list-inside space-y-1 text-xs">
                        <li>Go to Google AI Studio</li>
                        <li>Click "Create API key"</li>
                        <li>Copy the key and paste it above</li>
                        <li>Click "Save API Key" to apply changes</li>
                      </ul>
                    </div>
                  </div>

                  {/* Question Memory Statistics */}
                  <div className="p-6 bg-slate-50 rounded-[32px] border border-slate-100">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-bold text-slate-700 text-base flex items-center gap-2">
                        <Brain className="w-5 h-5 text-brand-500" />
                        Question Memory
                      </h3>
                      <button 
                        onClick={() => {
                          questionMemory.clear();
                          alert('Question memory cleared successfully!');
                        }}
                        className="text-xs px-3 py-1 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                      >
                        Clear Memory
                      </button>
                    </div>
                    <div className="text-sm text-slate-500">
                      {(() => {
                        const stats = questionMemory.getStats();
                        return (
                          <div className="space-y-2">
                            <div className="flex justify-between">
                              <span>Total Subjects:</span>
                              <span className="font-bold text-slate-700">{stats.totalSubjects}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Total Questions:</span>
                              <span className="font-bold text-slate-700">{stats.totalQuestions}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Total Topics:</span>
                              <span className="font-bold text-slate-700">{stats.totalTopics}</span>
                            </div>
                            {stats.subjects.length > 0 && (
                              <div className="mt-3 pt-3 border-t border-slate-200">
                                <p className="font-semibold text-xs text-slate-600 mb-2">Subject Breakdown:</p>
                                {stats.subjects.map(subject => (
                                  <div key={subject.subject} className="flex justify-between text-xs py-1">
                                    <span>{subject.subject}:</span>
                                    <span>{subject.questionCount} questions, {subject.topicCount} topics</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab !== 'settings' && (
              <>
                {/* Common Paper Metadata */}
                <div className="space-y-6 mb-10 pb-10 border-b border-slate-100">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Exam Name</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. Mid Semester Examination - II"
                      value={examName}
                      onChange={(e) => setExamName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Institute Name</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. Sagar Institute of Science and Technology"
                      value={instituteName}
                      onChange={(e) => setInstituteName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">College Logo</label>
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-slate-50 border border-brand-100 rounded-xl flex items-center justify-center overflow-hidden">
                        {logoUrl ? (
                          <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                        ) : (
                          <ImageIcon className="w-6 h-6 text-slate-300" />
                        )}
                      </div>
                      <label className="cursor-pointer px-4 py-2 bg-brand-50 text-brand-600 text-xs font-bold rounded-xl hover:bg-brand-100 transition-colors">
                        <Upload className="w-3 h-3 inline-block mr-2" />
                        Upload Logo
                        <input 
                          type="file" 
                          className="hidden" 
                          accept="image/*"
                          onChange={(e) => {
                            if (e.target.files && e.target.files[0]) {
                              const reader = new FileReader();
                              reader.onload = () => setLogoUrl(reader.result as string);
                              reader.readAsDataURL(e.target.files[0]);
                            }
                          }}
                        />
                      </label>
                      {logoUrl && (
                        <button 
                          onClick={() => setLogoUrl(null)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Subject Name</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. Data Structures & Algorithms"
                      value={subjectName}
                      onChange={(e) => setSubjectName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Subject Code</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. CS101"
                      value={subjectCode}
                      onChange={(e) => setSubjectCode(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Date of Exam</label>
                    <input 
                      type="date" 
                      className="input-field" 
                      value={examDate}
                      onChange={(e) => setExamDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Maximum Marks</label>
                    <input 
                      type="number" 
                      className="input-field" 
                      placeholder="e.g. 100"
                      value={maxMarks}
                      onChange={(e) => setMaxMarks(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Department</label>
                    <select 
                      className="input-field bg-white"
                      value={selectedDepartment}
                      onChange={(e) => setSelectedDepartment(e.target.value)}
                    >
                      <option value="" disabled>Select Department</option>
                      {[
                        "First Year (FY)",
                        "Computer Science and Engineering",
                        "CSE(AI&DS)",
                        "CSE(CY)",
                        "CSE(IT)",
                        "Electrical and Communication Engineering (ECE)",
                        "Mechanical Engineering (ME)",
                        "Civil Engineering (CE)",
                        "Electrical and Electronics Engineering (EEE)",
                        "Pharmacy (PY)",
                        "BBA",
                        "MBA"
                      ].sort().map(dept => (
                        <option key={dept} value={dept}>{dept}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Enrollment No.</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="e.g. 2024-CS-001"
                      value={enrollmentNo}
                      onChange={(e) => setEnrollmentNo(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Question Paper Format</label>
                    <select 
                      className="input-field"
                      value={paperFormat}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPaperFormat(val);
                        
                        // Set predefined counts for specific formats
                        if (val === "MST-I_SISTec") {
                          setTemplateCounts({ mcqCount: 12, shortCount: 6, longCount: 4 });
                        } else if (val === "MST -II format Dec 2025") {
                          setTemplateCounts({ mcqCount: 18, shortCount: 9, longCount: 3 });
                        } else if (val === "Standard") {
                          setTemplateCounts({ mcqCount: 10, shortCount: 5, longCount: 3 });
                        } else {
                          setTemplateCounts(null);
                        }

                        // If it's an uploaded template, also set selectedTemplateId
                        const template = templates.find(t => t.name === val);
                        if (template) {
                          setSelectedTemplateId(template.id);
                        }
                      }}
                    >
                      <option value="Standard">Standard University Format</option>
                      <option value="MST-I_SISTec">MST-I SISTec Format (12 MCQ, 6 Short, 4 Long)</option>
                      <option value="MST -II format Dec 2025">MST-II Dec 2025 Format (18 MCQ, 9 Short, 3 Long)</option>
                      <option value="Mid-Term">Mid-Term Examination Format</option>
                      <option value="End-Term">End-Term Examination Format</option>
                      <option value="Internal">Internal Assessment Format</option>
                      <option value="Competitive">Competitive Exam Format</option>
                      {templates.length > 0 && (
                        <optgroup label="Uploaded Templates">
                          {templates.map(t => (
                            <option key={t.id} value={t.name}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">Apply College Template</label>
                    <select 
                      className="input-field"
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                    >
                      <option value="">No Template (Default)</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    {templateCounts && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-3 p-4 bg-brand-50 rounded-2xl border border-brand-100 flex flex-wrap gap-4 items-center"
                      >
                        <Zap className="w-4 h-4 text-brand-500" />
                        <span className="text-xs font-bold text-brand-700 uppercase tracking-wider">Format Detected:</span>
                        <div className="flex gap-3">
                          <span className="px-2 py-1 bg-white rounded-lg text-[10px] font-black text-slate-600 border border-brand-100">{templateCounts.mcqCount} MCQs</span>
                          <span className="px-2 py-1 bg-white rounded-lg text-[10px] font-black text-slate-600 border border-brand-100">{templateCounts.shortCount} Short</span>
                          <span className="px-2 py-1 bg-white rounded-lg text-[10px] font-black text-slate-600 border border-brand-100">{templateCounts.longCount} Long</span>
                        </div>
                      </motion.div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">General Instructions</label>
                  <textarea 
                      className="input-field min-h-[80px] resize-none"
                      placeholder="e.g. 1. All questions are compulsory. 2. Use of scientific calculator is permitted."
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                  />
                </div>
            </div>

            <AnimatePresence mode="wait">
              {activeTab === 'prompt' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-slate-700">Describe your requirements</label>
                        <textarea 
                            className="input-field min-h-[120px] resize-none"
                            placeholder="e.g. Create 10 MCQs on Data Structures focusing on Graphs, medium difficulty."
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                        />
                      </div>
                      <div className="flex justify-end">
                          <button 
                              onClick={handlePromptGenerate}
                              disabled={isLoading || !prompt}
                              className="btn-primary flex items-center gap-2"
                          >
                              {isLoading ? (
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              ) : <Sparkles className="w-4 h-4" />}
                              {isLoading ? (loadingMessage || 'Generating...') : 'Generate Questions'}
                          </button>
                      </div>
                  </motion.div>
              )}

                  {activeTab === 'upload' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    {extractedQuestions.length === 0 ? (
                      <div className="border-2 border-dashed border-slate-200 rounded-3xl p-12 text-center hover:border-brand-500 transition-colors group">
                        <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                          <FileText className="w-8 h-8 text-slate-300 group-hover:text-brand-500" />
                        </div>
                        <h3 className="text-lg font-bold mb-2">Upload Previous Exam</h3>
                        <p className="text-sm text-slate-500 mb-8 max-w-xs mx-auto">Upload a PDF or Image. Our AI will extract and categorize questions automatically.</p>
                        <div className="relative inline-block">
                          <input type="file" accept=".pdf,image/*" onChange={(e) => handleFileUpload(e, 'paper')} className="absolute inset-0 opacity-0 cursor-pointer"/>
                          <button className="btn-secondary flex items-center gap-2 min-w-[140px] justify-center">
                            {isLoading ? (
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 border-2 border-brand-500/30 border-t-brand-500 rounded-full animate-spin" />
                                <span className="text-xs font-bold text-brand-600">Scanning...</span>
                              </div>
                            ) : (
                              <>
                                <Upload className="w-4 h-4" />
                                <span>Choose File</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <h3 className="text-lg font-bold">Extracted Questions ({extractedQuestions.length})</h3>
                            <button 
                              onClick={toggleSelectAll}
                              className="text-xs font-black uppercase tracking-widest text-brand-600 hover:text-brand-700 bg-brand-50 px-3 py-1 rounded-lg border border-brand-100 transition-colors"
                            >
                              {selectedQuestionIds.size === extractedQuestions.length ? 'Deselect All' : 'Select All'}
                            </button>
                          </div>
                          <div className="flex gap-3">
                            <button 
                              onClick={() => setExtractedQuestions([])}
                              className="text-sm font-bold text-slate-400 hover:text-slate-600"
                            >
                              Cancel
                            </button>
                            <button 
                              onClick={addSelectedQuestions}
                              disabled={selectedQuestionIds.size === 0}
                              className="btn-primary py-2 px-4 text-sm flex items-center gap-2"
                            >
                              <Plus className="w-4 h-4" />
                              Add Selected ({selectedQuestionIds.size})
                            </button>
                          </div>
                        </div>
                        
                        <div className="grid gap-8 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                          {Object.entries(
                            extractedQuestions.reduce((acc, q) => {
                              const section = q.section || 'Uncategorized';
                              if (!acc[section]) acc[section] = { title: q.sectionTitle || section, questions: [] };
                              acc[section].questions.push(q);
                              return acc;
                            }, {} as Record<string, { title: string, questions: Question[] }>)
                          ).map(([sectionKey, sectionData]: [string, any]) => (
                            <div key={sectionKey} className="space-y-4">
                              <div className="flex items-center gap-3 pb-2 border-b border-slate-100">
                                <div className="h-8 w-1 bg-brand-500 rounded-full" />
                                <h4 className="text-sm font-black uppercase tracking-widest text-slate-900">{sectionData.title}</h4>
                              </div>
                              
                              <div className="grid gap-4">
                                {sectionData.questions.map((q: any) => (
                                  <div 
                                    key={q.id}
                                    onClick={() => toggleQuestionSelection(q.id)}
                                    className={`p-4 rounded-2xl border transition-all cursor-pointer flex gap-4 ${selectedQuestionIds.has(q.id) ? 'border-brand-500 bg-brand-50/30' : 'border-slate-100 bg-white hover:border-slate-200'}`}
                                  >
                                    <div className={`w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${selectedQuestionIds.has(q.id) ? 'bg-brand-500 border-brand-500' : 'border-slate-200 bg-white'}`}>
                                      {selectedQuestionIds.has(q.id) && <Check className="w-4 h-4 text-white" />}
                                    </div>
                                    <div className="space-y-2 flex-1">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-black uppercase rounded-md">{q.type}</span>
                                          <span className="px-2 py-0.5 bg-brand-50 text-brand-600 text-[10px] font-black uppercase rounded-md">{q.marks} Marks</span>
                                        </div>
                                        <button 
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setEditingQuestion(q);
                                            setShowEditModal(true);
                                          }}
                                          className="p-1.5 text-slate-400 hover:text-brand-500 hover:bg-brand-50 rounded-lg transition-all"
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                      {q.type === QuestionType.LONG_ANSWER ? (
                                        <div className="flex gap-2">
                                          <span className="text-xs font-black text-brand-500 shrink-0">a)</span>
                                          <p className="text-sm font-medium text-slate-800 leading-relaxed whitespace-pre-wrap">{q.text}</p>
                                        </div>
                                      ) : (
                                        <p className="text-sm font-medium text-slate-800">{q.text}</p>
                                      )}
                                      {q.type === QuestionType.LONG_ANSWER && q.alternativeText && (
                                        <div className="mt-2 pl-4 border-l-2 border-slate-100">
                                          <div className="flex gap-2">
                                            <span className="text-xs font-black text-brand-500 shrink-0">b)</span>
                                            <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{q.alternativeText}</p>
                                          </div>
                                        </div>
                                      )}
                                      {q.hasImage && (
                                        <div className="mt-3 p-3 bg-brand-50/50 rounded-2xl border border-brand-100 flex flex-col gap-2">
                                          <div className="flex items-center gap-2 text-brand-700">
                                            <ImageIcon className="w-3.5 h-3.5" />
                                            <span className="text-[10px] font-black uppercase tracking-widest">Visual Element Detected</span>
                                          </div>
                                          
                                          <QuestionImage 
                                            question={q} 
                                            source={originalFile} 
                                            onCrop={(url) => updateQuestionImage(q.id, url)}
                                          />

                                          <div className="p-2 bg-white/80 rounded-xl border border-brand-100/50">
                                            <p className="text-[10px] text-slate-600 italic leading-relaxed">
                                              {q.imageDescription || "Analyzing visual content..."}
                                            </p>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
              )}

                  {activeTab === 'curriculum' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border-2 border-dashed border-slate-200 rounded-3xl p-12 text-center hover:border-brand-500 transition-colors group"
                  >
                      <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                        <BookOpen className="w-8 h-8 text-slate-300 group-hover:text-brand-500" />
                      </div>
                      <h3 className="text-lg font-bold mb-2">Analyze Curriculum</h3>
                      <p className="text-sm text-slate-500 mb-8 max-w-xs mx-auto">Upload your syllabus to generate a comprehensive topic-wise question bank.</p>
                      <div className="relative inline-block">
                        <input type="file" accept=".pdf,.docx" onChange={(e) => handleFileUpload(e, 'curriculum')} className="absolute inset-0 opacity-0 cursor-pointer"/>
                        <button className="btn-secondary flex items-center gap-2">
                          <Upload className="w-4 h-4" />
                          Choose File
                        </button>
                      </div>
                  </motion.div>
              )}
                </AnimatePresence>
              </>
            )}
        </div>
      </div>

      {/* Paper Builder Area */}
      <AnimatePresence>
        {(generatedQuestions.length > 0 || showAddModal) && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-8"
          >
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div className="flex-1 max-w-xl space-y-2">
                      <label className="text-sm font-bold text-slate-700">Paper Title</label>
                      <input 
                        type="text" 
                        value={paperTitle} 
                        onChange={(e) => setPaperTitle(e.target.value)}
                        placeholder="e.g. End Semester Examination - Fall 2024"
                        className="w-full text-2xl font-bold bg-transparent border-b-2 border-slate-200 focus:border-brand-500 outline-none pb-2 transition-colors"
                      />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setShowAddModal(true)} className="btn-secondary flex items-center gap-2">
                      <PlusCircle className="w-4 h-4" />
                      Add Question
                    </button>
                  </div>
              </div>

              {generatedQuestions.length > 0 && (
                  <div className="grid gap-12">
                     {Object.entries(
                        generatedQuestions.reduce((acc, q) => {
                          const section = q.section || 'Uncategorized';
                          if (!acc[section]) acc[section] = { title: q.sectionTitle || section, questions: [] };
                          acc[section].questions.push(q);
                          return acc;
                        }, {} as Record<string, { title: string, questions: Question[] }>)
                      ).map(([sectionKey, sectionData]: [string, any]) => (
                        <div key={sectionKey} className="space-y-6">
                          <div className="flex items-center gap-4 py-4 border-y-2 border-slate-900/5 bg-slate-50/50 px-6 rounded-2xl">
                            <div className="w-1.5 h-10 bg-slate-900 rounded-full" />
                            <div>
                              <h4 className="text-xl font-black uppercase tracking-[0.2em] text-slate-900">{sectionData.title}</h4>
                              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Section Identifier: {sectionKey}</p>
                            </div>
                          </div>

                          <div className="grid gap-6">
                            {sectionData.questions.map((q: any, idx: number) => (
                                <motion.div 
                                  key={q.id} 
                                  layout
                                  className="bg-white rounded-3xl p-6 border border-slate-100 shadow-sm hover:shadow-md transition-all relative group"
                                >
                                    <div className="flex justify-between items-start mb-4">
                                        <div className="flex items-center gap-2">
                                          <span className="w-8 h-8 bg-slate-900 text-white rounded-lg flex items-center justify-center text-xs font-black">
                                            {idx + 1}
                                          </span>
                                          <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-wider rounded-lg">
                                            {q.type}
                                          </span>
                                          <span className="px-2.5 py-1 bg-brand-50 text-brand-600 text-[10px] font-black uppercase tracking-wider rounded-lg">
                                            {q.marks} Marks
                                          </span>
                                        </div>
                                        <div className="flex gap-2">
                                          {(q.type === QuestionType.SHORT_ANSWER || q.type === QuestionType.LONG_ANSWER) && (
                                            <label className="p-2 text-slate-300 hover:text-green-500 hover:bg-green-50 rounded-xl transition-all cursor-pointer">
                                              <Upload className="w-4 h-4" />
                                              <input
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={(e) => handleImageUpload(q.id, e)}
                                              />
                                            </label>
                                          )}
                                          <button 
                                            onClick={() => {
                                              setEditingQuestion(q);
                                              setShowEditModal(true);
                                            }} 
                                            className="p-2 text-slate-300 hover:text-brand-500 hover:bg-brand-50 rounded-xl transition-all"
                                          >
                                             <Pencil className="w-4 h-4" />
                                          </button>
                                          <button 
                                            onClick={() => handleRemoveQuestion(q.id)} 
                                            className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                                          >
                                             <Trash2 className="w-4 h-4" />
                                          </button>
                                        </div>
                                    </div>
                                    
                                    {q.type === QuestionType.LONG_ANSWER ? (
                                      <div className="space-y-4 mb-6">
                                        <div className="flex gap-3">
                                          <span className="text-lg font-black text-brand-500 shrink-0">a)</span>
                                          <p className="text-lg font-medium text-slate-900 leading-relaxed whitespace-pre-wrap">{q.text}</p>
                                        </div>
                                        
                                        <div className="flex items-center justify-center py-2">
                                          <div className="h-px bg-slate-100 flex-1" />
                                          <span className="px-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">OR</span>
                                          <div className="h-px bg-slate-100 flex-1" />
                                        </div>

                                        <div className="flex gap-3">
                                          <span className="text-lg font-black text-brand-500 shrink-0">b)</span>
                                          <div className="flex-1">
                                            <p className="text-lg font-medium text-slate-900 leading-relaxed whitespace-pre-wrap">
                                              {q.alternativeText || '[Alternative Question Placeholder]'}
                                            </p>
                                            {q.hasAlternativeImage && q.alternativeImageUrl && (
                                              <div className="mt-4 p-4 bg-green-50 rounded-xl border border-green-100">
                                                <div className="flex items-center gap-2 text-green-600 mb-2">
                                                  <ImageIcon className="w-4 h-4" />
                                                  <span className="text-xs font-medium">Part B Image</span>
                                                </div>
                                                <img 
                                                  src={q.alternativeImageUrl} 
                                                  alt="Part B image" 
                                                  className="max-w-full h-auto rounded-lg shadow-sm"
                                                />
                                                <p className="text-xs text-green-600 mt-2 italic">
                                                  {q.alternativeImageDescription || 'Image uploaded for part b'}
                                                </p>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                        {q.type === QuestionType.LONG_ANSWER && (
                                          <label className="mt-2 flex items-center justify-center gap-2 p-2 text-slate-300 hover:text-green-500 hover:bg-green-50 rounded-xl transition-all cursor-pointer">
                                            <Upload className="w-4 h-4" />
                                            <span className="text-xs">Upload Image for Part B</span>
                                            <input
                                              type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={(e) => handleAlternativeImageUpload(q.id, e)}
                                            />
                                          </label>
                                        )}
                                      </div>
                                    ) : (
                                      <p className="text-lg font-medium text-slate-900 mb-6 leading-relaxed">{q.text}</p>
                                    )}
                                    
                                    {q.hasImage && (
                                        <div className="mb-6 p-6 bg-slate-50 rounded-[32px] border border-slate-100 flex flex-col gap-4">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2 text-slate-400">
                                                    <ImageIcon className="w-4 h-4" />
                                                    <span className="text-[10px] font-black uppercase tracking-[0.2em]">Visual Reference</span>
                                                </div>
                                                <div className={`px-2 py-1 text-[8px] font-black uppercase tracking-widest rounded-full ${
                                                  q.imageDescription?.includes('Uploaded image:') 
                                                    ? 'bg-green-100 text-green-700' 
                                                    : 'bg-brand-100 text-brand-700'
                                                }`}>
                                                    {q.imageDescription?.includes('Uploaded image:') ? 'User Uploaded' : 'AI Extracted'}
                                                </div>
                                            </div>
                                            
                                            <QuestionImage 
                                              question={q} 
                                              source={originalFile} 
                                              onCrop={(url) => updateQuestionImage(q.id, url)}
                                            />

                                            <div className="p-4 bg-white rounded-2xl border border-slate-200/50 shadow-sm">
                                                <p className="text-sm text-slate-600 italic leading-relaxed">
                                                    {q.imageDescription || "No description available."}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    
                                    {q.options && q.options.length > 0 && (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                                            {q.options.map((opt, i) => (
                                                <div key={i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100 text-sm text-slate-600">
                                                  <span className="w-6 h-6 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0">
                                                    {String.fromCharCode(65 + i)}
                                                  </span>
                                                  {opt}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    
                                    <div className="flex flex-col gap-2 p-3 bg-emerald-50/50 rounded-2xl border border-emerald-100/50 text-xs font-bold text-emerald-700">
                                       <div className="flex items-center gap-2">
                                         <CheckCircle2 className="w-4 h-4" />
                                         <span>Answer Key {q.type === QuestionType.LONG_ANSWER ? '(Main)' : ''}: {q.correctAnswer}</span>
                                       </div>
                                       {q.type === QuestionType.LONG_ANSWER && q.alternativeAnswer && (
                                         <div className="flex items-center gap-2 pl-6 opacity-70">
                                           <span>Alternative Answer Key: {q.alternativeAnswer}</span>
                                         </div>
                                       )}
                                    </div>
                                </motion.div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
              )}

              {generatedQuestions.length > 0 && (
                  <div className="flex flex-col md:flex-row justify-between items-center gap-6 bg-slate-900 p-8 rounded-[32px] text-white shadow-2xl shadow-slate-900/20">
                      <div className="flex flex-wrap gap-4">
                          <button onClick={() => handleExport('pdf')} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold">
                              <FileDown className="w-5 h-5" />
                              PDF
                          </button>
                          <button onClick={() => handleExport('docx')} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold">
                              <FileType className="w-5 h-5" />
                              DOCX
                          </button>
                          <button onClick={() => handleExport('txt')} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold">
                              <Download className="w-5 h-5" />
                              TXT
                          </button>
                      </div>
                      
                       <div className="flex gap-4 w-full md:w-auto">
                         <button 
                            onClick={handleSaveDraft}
                            disabled={isLoading}
                            className="flex-1 md:flex-none px-8 py-3 bg-brand-500 hover:bg-brand-400 text-white rounded-2xl font-bold transition-all shadow-lg shadow-brand-500/20 flex items-center justify-center gap-2"
                         >
                            {isLoading ? (
                               <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : <Save className="w-4 h-4" />}
                            {isLoading ? 'Saving...' : 'Save Draft'}
                         </button>
                      </div>
                  </div>
              )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Question Modal */}
      <AnimatePresence>
        {showAddModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setShowAddModal(false)}
                  className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                />
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 20 }}
                  className="bg-white p-8 rounded-[32px] w-full max-w-lg shadow-2xl relative z-10"
                >
                    <div className="flex items-center justify-between mb-8">
                      <h3 className="text-2xl font-bold">Add Custom Question</h3>
                      <button onClick={() => setShowAddModal(false)} className="p-2 hover:bg-slate-100 rounded-xl transition-colors">
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    
                    <div className="space-y-6">
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <label className="text-sm font-bold text-slate-700">Question Text (Part a)</label>
                          </div>
                          <textarea 
                             className="input-field min-h-[100px] resize-none" 
                             placeholder="Type the main question (a) here..."
                             value={customQuestion.text || ''}
                             onChange={e => setCustomQuestion({...customQuestion, text: e.target.value})}
                          />
                        </div>

                        {customQuestion.type === QuestionType.LONG_ANSWER && (
                          <div className="space-y-2">
                            <div className="flex justify-between items-center">
                              <label className="text-sm font-bold text-slate-700">Alternative Question (Part b / OR Part)</label>
                            </div>
                            <textarea 
                               className="input-field min-h-[100px] resize-none" 
                               placeholder="Type the alternative question (b) here..."
                               value={customQuestion.alternativeText || ''}
                               onChange={e => setCustomQuestion({...customQuestion, alternativeText: e.target.value})}
                            />
                          </div>
                        )}
                        
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Section ID (e.g. Part A)</label>
                              <input 
                                 type="text"
                                 className="input-field" 
                                 placeholder="Section ID"
                                 value={customQuestion.section || ''}
                                 onChange={e => setCustomQuestion({...customQuestion, section: e.target.value})}
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Section Title (e.g. Objective)</label>
                              <input 
                                 type="text"
                                 className="input-field" 
                                 placeholder="Section Title"
                                 value={customQuestion.sectionTitle || ''}
                                 onChange={e => setCustomQuestion({...customQuestion, sectionTitle: e.target.value})}
                              />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Type</label>
                              <select 
                                className="input-field"
                                value={customQuestion.type}
                                onChange={e => {
                                  const type = e.target.value as QuestionType;
                                  let marks = customQuestion.marks;
                                  if (type === QuestionType.MCQ) marks = 0.5;
                                  else if (type === QuestionType.SHORT_ANSWER) marks = 2;
                                  else if (type === QuestionType.LONG_ANSWER) marks = 7;
                                  setCustomQuestion({...customQuestion, type, marks});
                                }}
                              >
                                  <option value={QuestionType.SHORT_ANSWER}>Short Answer</option>
                                  <option value={QuestionType.MCQ}>MCQ</option>
                                  <option value={QuestionType.LONG_ANSWER}>Long Answer</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Marks</label>
                              <input 
                                 type="number" 
                                 className="input-field"
                                 placeholder="5"
                                 value={customQuestion.marks}
                                 onChange={e => setCustomQuestion({...customQuestion, marks: Number(e.target.value)})}
                              />
                            </div>
                        </div>
                        
                        <div className="space-y-2">
                          <label className="text-sm font-bold text-slate-700">Correct Answer / Key</label>
                          <input 
                             type="text" 
                             className="input-field" 
                             placeholder={customQuestion.type === QuestionType.LONG_ANSWER ? "Answer for part a..." : "Expected answer..."}
                             value={customQuestion.correctAnswer || ''}
                             onChange={e => setCustomQuestion({...customQuestion, correctAnswer: e.target.value})}
                          />
                        </div>

                        {customQuestion.type === QuestionType.LONG_ANSWER && (
                          <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700">Alternative Answer (OR Part)</label>
                            <input 
                               type="text" 
                               className="input-field" 
                               placeholder="Answer for part b..."
                               value={customQuestion.alternativeAnswer || ''}
                               onChange={e => setCustomQuestion({...customQuestion, alternativeAnswer: e.target.value})}
                            />
                          </div>
                        )}
                        
                        {customQuestion.type === QuestionType.MCQ && (
                            <div className="flex gap-2 p-3 bg-slate-50 rounded-2xl border border-slate-100">
                              <AlertCircle className="w-4 h-4 text-slate-400 shrink-0" />
                              <p className="text-[10px] text-slate-500 font-medium">Note: Default options (A, B, C, D) will be added for MCQs. You can edit them later.</p>
                            </div>
                        )}
                    </div>
                    
                    <div className="flex gap-3 mt-10">
                        <button onClick={() => setShowAddModal(false)} className="flex-1 btn-secondary">Cancel</button>
                        <button onClick={handleAddCustomQuestion} className="flex-1 btn-primary">Add Question</button>
                    </div>
                </motion.div>
            </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showEditModal && editingQuestion && (
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[110] p-4 overflow-y-auto">
                <motion.div 
                    initial={{ scale: 0.9, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.9, opacity: 0, y: 20 }}
                    className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl p-8 relative"
                >
                    <button 
                        onClick={() => setShowEditModal(false)}
                        className="absolute top-6 right-6 p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
                    >
                        <X className="w-5 h-5" />
                    </button>
                    
                    <div className="mb-8">
                        <div className="w-12 h-12 bg-brand-50 rounded-2xl flex items-center justify-center mb-4">
                            <Pencil className="w-6 h-6 text-brand-500" />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Edit Question</h3>
                        <p className="text-slate-500 text-sm">Modify the question details below.</p>
                    </div>
                    
                    <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                        <div className="space-y-2">
                          <label className="text-sm font-bold text-slate-700">Question Text</label>
                          <textarea 
                             className="input-field min-h-[100px] resize-none" 
                             placeholder="Enter question text..."
                             value={editingQuestion.text}
                             onChange={e => setEditingQuestion({...editingQuestion, text: e.target.value})}
                          />
                        </div>

                        {editingQuestion.type === QuestionType.LONG_ANSWER && (
                          <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700">Alternative Question (OR Part)</label>
                            <textarea 
                               className="input-field min-h-[100px] resize-none" 
                               placeholder="Enter alternative question text..."
                               value={editingQuestion.alternativeText || ''}
                               onChange={e => setEditingQuestion({...editingQuestion, alternativeText: e.target.value})}
                            />
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Type</label>
                              <select 
                                 className="input-field"
                                 value={editingQuestion.type}
                                 onChange={e => setEditingQuestion({...editingQuestion, type: e.target.value as QuestionType})}
                              >
                                <option value={QuestionType.MCQ}>Multiple Choice</option>
                                <option value={QuestionType.SHORT_ANSWER}>Short Answer</option>
                                <option value={QuestionType.LONG_ANSWER}>Long Answer (with OR)</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Marks</label>
                              <input 
                                 type="number" 
                                 className="input-field" 
                                 placeholder="5"
                                 value={editingQuestion.marks}
                                 onChange={e => setEditingQuestion({...editingQuestion, marks: Number(e.target.value)})}
                              />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Difficulty</label>
                              <select 
                                 className="input-field"
                                 value={editingQuestion.difficulty}
                                 onChange={e => setEditingQuestion({...editingQuestion, difficulty: e.target.value as Difficulty})}
                              >
                                <option value={Difficulty.EASY}>Easy</option>
                                <option value={Difficulty.MEDIUM}>Medium</option>
                                <option value={Difficulty.HARD}>Hard</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-bold text-slate-700">Section</label>
                              <input 
                                 type="text" 
                                 className="input-field" 
                                 placeholder="Section A"
                                 value={editingQuestion.section || ''}
                                 onChange={e => setEditingQuestion({...editingQuestion, section: e.target.value})}
                              />
                            </div>
                        </div>
                        
                        <div className="space-y-2">
                          <label className="text-sm font-bold text-slate-700">Correct Answer / Key</label>
                          <input 
                             type="text" 
                             className="input-field" 
                             placeholder="Expected answer..."
                             value={editingQuestion.correctAnswer || ''}
                             onChange={e => setEditingQuestion({...editingQuestion, correctAnswer: e.target.value})}
                          />
                        </div>

                        {editingQuestion.type === QuestionType.LONG_ANSWER && (
                          <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700">Alternative Answer (OR Part)</label>
                            <input 
                               type="text" 
                               className="input-field" 
                               placeholder="Answer for part b..."
                               value={editingQuestion.alternativeAnswer || ''}
                               onChange={e => setEditingQuestion({...editingQuestion, alternativeAnswer: e.target.value})}
                            />
                          </div>
                        )}
                        
                        {editingQuestion.type === QuestionType.MCQ && editingQuestion.options && (
                            <div className="space-y-3">
                              <label className="text-sm font-bold text-slate-700">Options</label>
                              <div className="grid gap-2">
                                {editingQuestion.options.map((opt, idx) => (
                                  <div key={idx} className="flex gap-2">
                                    <span className="w-8 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-xs font-black text-slate-500 shrink-0">
                                      {String.fromCharCode(65 + idx)}
                                    </span>
                                    <input 
                                      type="text"
                                      className="input-field"
                                      value={opt}
                                      onChange={e => {
                                        const newOpts = [...(editingQuestion.options || [])];
                                        newOpts[idx] = e.target.value;
                                        setEditingQuestion({...editingQuestion, options: newOpts});
                                      }}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                        )}
                    </div>
                    
                    <div className="flex gap-3 mt-10">
                        <button onClick={() => setShowEditModal(false)} className="flex-1 btn-secondary">Cancel</button>
                        <button onClick={() => handleUpdateQuestion(editingQuestion)} className="flex-1 btn-primary">Save Changes</button>
                    </div>
                </motion.div>
            </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSaved && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-3 z-[100]"
          >
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <span className="font-bold">{saveMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isLoading && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[110]"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-8 rounded-[32px] shadow-2xl flex flex-col items-center max-w-sm w-full mx-4 text-center space-y-6"
            >
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 border-4 border-slate-100 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-brand-500 rounded-full border-t-transparent animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-brand-500 animate-pulse" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-slate-900">AI is working...</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{loadingMessage || 'Processing your request'}</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-8 left-1/2 -translate-x-1/2 bg-red-500 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-3 z-[120]"
          >
              <AlertCircle className="w-5 h-5" />
              <span className="font-bold">{error}</span>
              <button onClick={() => setError(null)} className="ml-4 p-1 hover:bg-white/20 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {paperToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPaperToDelete(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[32px] shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 bg-red-50 rounded-2xl flex items-center justify-center text-red-500">
                    <AlertCircle className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-bold text-slate-900">Delete Paper</h3>
                    <p className="text-sm text-slate-500">This action cannot be undone.</p>
                  </div>
                </div>
                <p className="text-slate-600 mb-8">Are you sure you want to delete this question paper?</p>
                <div className="flex gap-4">
                  <button 
                    onClick={() => setPaperToDelete(null)}
                    className="flex-1 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-bold transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmDeletePaper}
                    className="flex-1 px-6 py-3 bg-red-500 hover:bg-red-400 text-white rounded-2xl font-bold transition-all shadow-lg shadow-red-500/20"
                  >
                    Delete Paper
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default FacultyDashboard;
