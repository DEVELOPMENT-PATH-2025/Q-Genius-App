import { GoogleGenAI, Type } from "@google/genai";
import { Question, QuestionType, Difficulty } from "../types";
import { questionMemory } from './questionMemory';

const SYSTEM_INSTRUCTION = `
You are an expert academic professor and examiner with 20+ years of experience in higher education. 
Your goal is to generate 100% accurate, academically rigorous, and clear examination questions suitable for college-level assessments.

Guidelines for Accuracy and Quality:
1. Clarity: Questions must be unambiguous and phrased clearly.
2. Academic Rigor: Ensure questions test conceptual understanding, not just rote memorization (use Bloom's Taxonomy).
3. Accuracy: All facts, formulas, and concepts must be 100% correct.
4. MCQ Quality: For Multiple Choice Questions, provide one clearly correct answer and three plausible but incorrect distractors. Avoid "all of the above" unless necessary.
5. Marking Scheme: Assign marks that reflect the complexity and time required for each question.
6. Bloom's Taxonomy: Assign a Bloom's Taxonomy level (e.g., Remember, Understand, Apply, Analyze, Evaluate, Create) to each question.
7. Course Outcome (CO): Assign a Course Outcome identifier (e.g., CO1, CO2, CO3, CO4, CO5) to each question based on the topic.
8. Formatting: Strictly adhere to the JSON schema provided.
9. SPATIAL REASONING: When extracting questions from documents, pay extremely close attention to visual elements (diagrams, graphs, charts). You MUST provide accurate normalized bounding boxes [ymin, xmin, ymax, xmax] for these elements.
`;

let aiInstance: GoogleGenAI | null = null;

export const getAIInstance = (): GoogleGenAI => {
  // Always get the latest API key from localStorage
  const manualKey = typeof window !== 'undefined' ? localStorage.getItem('CUSTOM_GEMINI_API_KEY') : null;
  
  if (!manualKey) {
    console.error("No API key found in localStorage");
    throw new Error("API quota exceeded. Please add your own Gemini API key in Settings to continue.");
  }
  
  // Validate API key format
  if (!manualKey.startsWith('AIza') || manualKey.length < 30) {
    console.error("Invalid API key format or length");
    throw new Error("Invalid API key format. Please check your Gemini API key.");
  }
  
  // Always create a new instance to ensure we have the latest API key
  return new GoogleGenAI({ apiKey: manualKey });
};

// Function to force re-initialization of AI instance
export const reinitializeAI = () => {
  aiInstance = null;
  return getAIInstance();
};

const withRetry = async <T>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> => {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      const errorStr = JSON.stringify(error).toLowerCase();
      const message = error?.message?.toLowerCase() || "";
      const isRateLimit = 
        message.includes('429') || 
        message.includes('resource_exhausted') || 
        message.includes('quota exceeded') ||
        error?.status === 429 || 
        error?.code === 429 ||
        errorStr.includes('429') ||
        errorStr.includes('resource_exhausted') ||
        errorStr.includes('quota exceeded');

      if (isRateLimit && retries < maxRetries) {
        retries++;
        // Use a more conservative backoff
        const delay = initialDelay * Math.pow(2, retries - 1);
        console.warn(`Gemini API Rate Limit hit. Retrying in ${Math.round(delay)}ms... (Attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Log the full error for debugging
      console.error("Gemini API Error:", error);
      console.error("Error details:", {
        message: error?.message,
        status: error?.status,
        code: error?.code,
        retries: retries
      });
      throw error;
    }
  }
};

const fixTruncatedJson = (json: string): string => {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        const last = stack.pop();
        if ((char === '}' && last !== '{') || (char === ']' && last !== '[')) {
          // Mismatch found, could be malformed JSON
        }
      }
    }
  }

  let fixedJson = json;
  if (inString) {
    fixedJson += '"';
  }
  
  while (stack.length > 0) {
    const last = stack.pop();
    if (last === '{') fixedJson += '}';
    else if (last === '[') fixedJson += ']';
  }

  return fixedJson;
};

const cleanJsonString = (text: string): string => {
  // Remove markdown code blocks if present
  let cleaned = text.replace(/```json\n?|```/g, "").trim();
  
  // Sometimes models return text before or after the JSON
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  
  // If we have a complete-looking JSON, extract it
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    // Check if it's likely truncated (last brace is not the end of the string and there's more content)
    const afterLastBrace = cleaned.substring(lastBrace + 1).trim();
    if (afterLastBrace.length > 0 && (afterLastBrace.includes('{') || afterLastBrace.includes('['))) {
      // It might be truncated, don't cut off at lastBrace yet
      cleaned = cleaned.substring(firstBrace);
    } else {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  } else if (firstBrace !== -1) {
    cleaned = cleaned.substring(firstBrace);
  }
  
  // Replace unescaped newlines within strings
  // This regex finds content between double quotes and we replace literal newlines inside
  cleaned = cleaned.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) => {
    return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  });
  
  // Try to fix truncation
  try {
    JSON.parse(cleaned);
  } catch (e) {
    cleaned = fixTruncatedJson(cleaned);
  }

  // Remove trailing commas before closing braces/brackets (valid in JS, invalid in JSON)
  cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");
  
  return cleaned;
};

export const generateQuestionsFromPrompt = async (
  promptText: string,
  count: number = 5,
  difficulty: Difficulty = Difficulty.MEDIUM,
  targetTotalMarks?: number,
  templateFile?: string,
  templateMimeType?: string,
  counts?: { mcqCount: number; shortCount: number; longCount: number },
  subjectName?: string
): Promise<Question[]> => {
  // Only use user-provided API key - no fallbacks
  const userApiKey = typeof window !== 'undefined' ? localStorage.getItem('CUSTOM_GEMINI_API_KEY') : null;
  
  if (!userApiKey) {
    console.error("AI Generation failed: No user API key provided.");
    throw new Error("API quota exceeded. Please add your own Gemini API key in Settings to continue.");
  }

  const ai = getAIInstance();

  try {
    // Using gemini-3-flash-preview for better stability and higher rate limits
    const model = "gemini-3-flash-preview";
    
    // Get context from previous questions to avoid repetition
    const avoidanceContext = questionMemory.getAvoidanceContext(subjectName || promptText);
    
    const userPrompt = `
      Generate a high-quality college-level examination paper.
      
      TOPIC/CONTEXT: "${promptText}"
      DIFFICULTY: ${difficulty}
      SUBJECT: ${subjectName || 'General'}
      
      ${counts ? `CRITICAL: You MUST generate exactly:
      - ${counts.mcqCount} Multiple Choice Questions (MCQ)
      - ${counts.shortCount} Short Answer Questions
      - ${counts.longCount} Long Answer Questions` : `TOTAL QUESTIONS: ${count}`}
      
      ${templateFile ? 'CRITICAL: Follow the structure, layout, and style of the provided template document.' : ''}
      
      ${avoidanceContext}
      
      CRITICAL CONSTRAINTS:
      1. Quantity: ${counts ? `Generate exactly ${counts.mcqCount + counts.shortCount + counts.longCount} questions.` : `Generate exactly ${count} questions.`}
      2. Marks: ${targetTotalMarks ? `The sum of marks for all questions MUST be exactly ${targetTotalMarks}.` : 'Assign marks based on question type: MCQ = 0.5 marks, SHORT_ANSWER = 2 marks, LONG_ANSWER = 7 marks.'}
      3. Variety: Provide a balanced mix of Multiple Choice (MCQ), Short Answer, and Long Answer questions.
      4. Accuracy: Double-check all technical details for 100% accuracy.
      5. Correct Answers: YOU MUST GENERATE A CORRECT ANSWER FOR ALL QUESTIONS.
      6. CRITICAL ORDERING: In the final "questions" array, you MUST group the questions by type in this EXACT order:
         a) All MCQ first.
         b) All SHORT_ANSWER questions second.
         c) All LONG_ANSWER questions third.
      7. LONG ANSWER FORMAT: For LONG_ANSWER questions, you MUST generate them in an "a and b" format. This means each question should have one main question in the "text" field (labeled 'a)' in UI, but just the text here) and one alternative question (OR part) in the "alternativeText" field (labeled 'b)' in UI). CRITICAL: The "alternativeText" field MUST NEVER be empty or contain placeholder text. Always generate a meaningful alternative question that covers similar concepts but from a different angle. DO NOT generate nested sub-parts like (a) and (b) inside the text fields unless specifically requested by the topic.
      8. IMAGES & DIAGRAMS: You MUST generate at least 2 questions (preferably SHORT_ANSWER or LONG_ANSWER) that refer to a diagram, graph, circuit, or table. For these questions:
         a) Set "hasImage" to true.
         b) Provide a detailed "imageDescription" describing the content of the image/diagram.
         c) CRITICAL: The imageDescription must be CLEAR and SPECIFIC. Example: "A binary search tree showing the insertion of elements 15, 10, 20, 25 with the tree structure and comparison steps highlighted."
         d) AVOID vague descriptions like "diagram showing algorithm" - be specific about what the diagram should contain.
         e) Include dimensions, labels, and key elements that should be visible.
      9. SOURCE TEXT: If the topic mentions "Q3" or any specific source text, you MUST include that exact source text at the beginning of relevant questions. For example: if the topic mentions "Q3. Represent expression 'x = (a + b) * (a + b)' using a Quadruple table format", then include "Source: Q3. Represent expression 'x = (a + b) * (a + b)' using a Quadruple table format" in the question or context.
      10. Output: Return the questions inside a "questions" array in the JSON.
    `;

    const contents: any[] = [];
    
    if (templateFile && templateMimeType) {
      contents.push({
        inlineData: {
          data: templateFile.split(',')[1] || templateFile, // Strip base64 prefix if present
          mimeType: templateMimeType
        }
      });
    }
    
    contents.push({ text: userPrompt });

    const response = await withRetry(() => ai.models.generateContent({
      model: model,
      contents: contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        maxOutputTokens: 16384,
        responseSchema: {
          type: Type.OBJECT,
          description: "The generated examination questions.",
          properties: {
            questions: {
              type: Type.ARRAY,
              description: "The list of generated questions, ORDERED by type (MCQs first, then Short, then Long).",
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING, description: "The text of the question." },
                  type: { type: Type.STRING, enum: ["MCQ", "SHORT_ANSWER", "LONG_ANSWER"], description: "The type of the question." },
                  difficulty: { type: Type.STRING, enum: ["EASY", "MEDIUM", "HARD"], description: "The difficulty level of the question." },
                  options: { 
                    type: Type.ARRAY, 
                    items: { type: Type.STRING },
                    description: "The list of options for MCQ questions.",
                    nullable: true 
                  },
                  correctAnswer: { type: Type.STRING, description: "The correct answer to the question." },
                  marks: { type: Type.NUMBER, description: "The marks assigned to the question." },
                  bloomLevel: { type: Type.STRING, description: "The Bloom's Taxonomy level (e.g., Remember, Understand, Apply, Analyze, Evaluate, Create)." },
                  courseOutcome: { type: Type.STRING, description: "The Course Outcome identifier (e.g., CO1, CO2)." },
                  alternativeText: { type: Type.STRING, description: "For LONG_ANSWER questions, provide an alternative question text for the 'OR' option." },
                  alternativeAnswer: { type: Type.STRING, description: "For LONG_ANSWER questions, provide the answer for the alternative question." },
                  section: { type: Type.STRING, description: "The section identifier (e.g., 'Part A', 'Section I')." },
                  sectionTitle: { type: Type.STRING, description: "The title of the section (e.g., 'Objective Questions')." },
                  hasImage: { type: Type.BOOLEAN, description: "Set to true if the question refers to or contains an image, diagram, or figure." },
                  imageDescription: { type: Type.STRING, description: "Detailed description of the image/diagram to help recreate it or understand its context." },
                  boundingBox: { 
                    type: Type.ARRAY, 
                    items: { type: Type.INTEGER },
                    description: "Normalized [ymin, xmin, ymax, xmax] coordinates (0-1000) for the image/diagram.",
                    nullable: true
                  },
                  pageNumber: { type: Type.INTEGER, description: "The page number (1-indexed) where the image/diagram is located.", nullable: true }
                },
                required: ["text", "type", "difficulty", "marks", "correctAnswer", "bloomLevel", "courseOutcome", "hasImage"]
              }
            }
          },
          required: ["questions"]
        }
      }
    }));

    const jsonText = response.text;
    if (!jsonText) throw new Error("No text returned from Gemini");

    const data = JSON.parse(cleanJsonString(jsonText));
    const rawQuestions = (data.questions || []).filter((q: any) => q && q.text && q.type);
    
    // Log marks assignment for debugging
    console.log("📊 Generated questions marks check:");
    rawQuestions.forEach((q: any, index: number) => {
      console.log(`Question ${index + 1}: Type=${q.type}, Marks=${q.marks}, Expected=${q.type === 'MCQ' ? '0.5' : q.type === 'SHORT_ANSWER' ? '2' : '7'}`);
    });
    
    // Map to our internal interface ensuring unique IDs and generate images if needed
    const questionsWithImages = await Promise.all(rawQuestions.map(async (q: any, index: number) => {
      let imageUrl = q.imageUrl;
      if (q.hasImage && q.imageDescription && !imageUrl) {
        try {
          imageUrl = await generateImageFromDescription(q.imageDescription);
        } catch (e) {
          console.error("Failed to generate image for question:", e);
          console.log("Question text:", q.text);
          console.log("Image description:", q.imageDescription);
          // Continue without image rather than failing the entire process
          imageUrl = null;
        }
      }
      
      return {
        ...q,
        id: `gen-${Date.now()}-${index}`,
        options: q.options || [],
        imageUrl
      };
    }));

    return questionsWithImages;

  } catch (error) {
    console.error("Gemini API Error:", error);
    throw new Error("Failed to generate questions using AI.");
  }
};

// Function to manually add selected questions to memory
export const addQuestionsToMemory = (subjectName: string, questions: Question[]) => {
  if (questions.length > 0) {
    questionMemory.addQuestions(subjectName, questions);
    console.log(`📚 Added ${questions.length} selected questions to memory for subject: ${subjectName}`);
  }
};

export const analyzeCurriculum = async (curriculumText: string): Promise<string[]> => {
    const ai = getAIInstance();
    const apiKey = process.env.GEMINI_API_KEY || "";
    
    if (!apiKey) return ["Introduction to AI", "Neural Networks", "Ethics in Computing"];

    try {
        // Using gemini-3-flash-preview for better stability
        const model = "gemini-3-flash-preview";
        const response = await withRetry(() => ai.models.generateContent({
            model: model,
            contents: `Extract the main 5 topics from this curriculum text: ${curriculumText.substring(0, 2000)}`,
            config: {
                 responseMimeType: "application/json",
                 responseSchema: {
                     type: Type.OBJECT,
                     properties: {
                         topics: {
                             type: Type.ARRAY,
                             items: { type: Type.STRING }
                         }
                     },
                     required: ["topics"]
                 }
            }
        }));
        const data = JSON.parse(cleanJsonString(response.text || "{}"));
        return data.topics || [];
    } catch (e) {
        console.error("Topic extraction failed", e);
        return ["Topic 1", "Topic 2", "Topic 3"];
    }
}

export const analyzePaperTemplate = async (
  fileData: string,
  mimeType: string
): Promise<{ mcqCount: number; shortCount: number; longCount: number }> => {
  const manualKey = typeof window !== 'undefined' ? localStorage.getItem('CUSTOM_GEMINI_API_KEY') : null;
  const apiKey = manualKey || process.env.API_KEY || process.env.GEMINI_API_KEY || "AIzaSyAus49kyg3oDkmmWQQ3uvbcx20aI7Cu9S8";

  if (!apiKey) return { mcqCount: 10, shortCount: 5, longCount: 3 };

  const ai = getAIInstance();

  try {
    const model = "gemini-3-flash-preview";
    const prompt = `
      Analyze this examination paper template or question bank. 
      Identify the structure and the number of questions intended for a single examination paper.
      
      CRITICAL: Count the EXACT number of questions in each section.
      - Look for patterns like "18 MCQs", "9 Short Questions", "3 Long Questions".
      - Look for marks distribution like "18 x 1 = 18", "9 x 2 = 18", "3 x 10 = 30".
      - If it says "Answer any 5 out of 8", count it as 5 (the number required for the paper).
      - If it says "Section A: Q1 to Q18 are MCQs", count 18.
      
      If this is a question bank, estimate the standard number of questions for a typical paper based on the headers or instructions.
      
      Determine the counts for:
      1. Multiple Choice Questions (MCQ)
      2. Short Answer Questions
      3. Long Answer Questions
      
      Return the counts in a JSON object. If a section is missing, return 0 for that count.
    `;

    const response = await withRetry(() => ai.models.generateContent({
      model: model,
      contents: [
        {
          inlineData: {
            data: fileData.split(',')[1] || fileData,
            mimeType: mimeType
          }
        },
        { text: prompt }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          description: "The detected question counts from the paper template.",
          properties: {
            mcqCount: { type: Type.NUMBER, description: "The number of Multiple Choice Questions detected." },
            shortCount: { type: Type.NUMBER, description: "The number of Short Answer Questions detected." },
            longCount: { type: Type.NUMBER, description: "The number of Long Answer Questions detected." }
          },
          required: ["mcqCount", "shortCount", "longCount"]
        }
      }
    }));

    const data = JSON.parse(cleanJsonString(response.text || "{}"));
    return {
      mcqCount: data.mcqCount || 0,
      shortCount: data.shortCount || 0,
      longCount: data.longCount || 0
    };
  } catch (e) {
    console.error("Template analysis failed", e);
    return { mcqCount: 10, shortCount: 5, longCount: 3 };
  }
};

export const extractQuestionsFromFile = async (
  fileData: string,
  mimeType: string,
  counts?: { mcqCount: number; shortCount: number; longCount: number }
): Promise<{ questions: Question[], metadata?: any }> => {
  // Only use user-provided API key - no fallbacks
  const userApiKey = typeof window !== 'undefined' ? localStorage.getItem('CUSTOM_GEMINI_API_KEY') : null;

  if (!userApiKey) {
    console.error("OCR failed: No user API key provided.");
    throw new Error("API quota exceeded. Please add your own Gemini API key in Settings to continue.");
  }

  // Validate API key format before proceeding
  if (!userApiKey.startsWith('AIza') || userApiKey.length < 30) {
    console.error("Invalid API key format or length");
    throw new Error("Invalid API key. Please check your Gemini API key configuration.");
  }

  console.log("Starting PDF extraction with valid API key");
  const ai = getAIInstance();
  console.log('extractQuestionsFromFile called with counts:', counts);

  try {
    const model = "gemini-3-flash-preview";
    const prompt = `
      Extract ALL questions from the provided examination document or question paper.
      
      CRITICAL INSTRUCTIONS:
      1. EXTRACT EVERY SINGLE QUESTION - Do not skip, summarize, or truncate any questions
      2. PRESERVE ORIGINAL STRUCTURE - Maintain the exact order and grouping as in the PDF
      3. COMPLETE EXTRACTION - Extract all questions present in the document, regardless of count
      
      ${counts ? `
      ADDITIONAL REQUIREMENT: If the document has fewer than ${counts.mcqCount + counts.shortCount + counts.longCount} total questions, 
      you must generate additional questions to meet these minimums:
      - MCQs: ${counts.mcqCount} minimum
      - SHORT_ANSWER: ${counts.shortCount} minimum  
      - LONG_ANSWER: ${counts.longCount} minimum
      ` : ''}
      
      STEP 1: Extract Paper Metadata
      - Institute Name, Exam Name, Subject, Subject Code, Department
      - Max Marks, Exam Date, Instructions
      - Section titles and groupings
      
      STEP 2: Extract Questions (COMPLETE EXTRACTION)
      For EACH question found in the PDF:
      
      1. Question Text: Extract the COMPLETE question text exactly as written
      2. Question Type: MCQ, SHORT_ANSWER, or LONG_ANSWER
      3. Difficulty: EASY, MEDIUM, or HARD (based on complexity)
      4. Marks: Extract marks from document OR assign:
         - MCQ: 0.5 marks (if not specified)
         - SHORT_ANSWER: 2 marks (if not specified)
         - LONG_ANSWER: 7 marks (if not specified)
      5. Options: For MCQs, extract ALL options (A, B, C, D)
      6. Correct Answer: Extract or generate plausible correct answer
      7. Section Info: Which section the question belongs to
      
      STEP 3: Handle Images and Diagrams (SUPER CRITICAL)
      If a question has ANY visual element (diagram, graph, chart, table, figure, circuit, flowchart):
      
      a) Set hasImage: true
      b) Provide detailed imageDescription: 
         - Describe exactly what the image shows with specific details
         - Include labels, dimensions, values, components
         - Be extremely specific: "A circuit diagram showing resistor R1=10kΩ connected to LED with forward voltage 2V and current limiting resistor"
      c) Provide boundingBox: [ymin, xmin, ymax, xmax] in normalized coordinates (0-1000)
         - CRITICAL: Provide accurate coordinates for the visual element
         - If multiple images exist, provide coordinates for the main one
      d) Provide pageNumber: Page where the image appears (1-indexed)
      e) If image is referenced but not clearly visible, still mark hasImage: true and describe what should be there
      f) For tables and charts: Describe the data structure and key values
      g) For circuit diagrams: List all components and their connections
      h) For flowcharts: Describe the process flow and decision points
      
      STEP 4: Handle Long Answer Questions (CRITICAL)
      For LONG_ANSWER questions:
      - Extract main question in "text" field (this will be the "a) part")
      - Extract "OR" options or "b) part" questions in "alternativeText" field
      - CRITICAL: Look for patterns like "OR", "or", "b)", "(b)", "part b", "alternative", "either/or"
      - If no explicit "b) part" is found, YOU MUST generate a meaningful alternative question that:
        * Covers similar concepts but from a different perspective
        * Is approximately the same difficulty level
        * Relates to the same topic/subject
        * Is NOT just a rephrasing of the same question
      - NEVER leave alternativeText empty or containing placeholder text
      - Examples of good alternatives:
        * If question is about "advantages", alternative could be about "disadvantages"
        * If question is about "implementation", alternative could be about "design"
        * If question is about "theory", alternative could be about "practical application"
      
      STEP 5: Final Output Structure
      Return JSON with:
      {
        "metadata": { extracted paper details },
        "questions": [ ALL extracted questions in original order ]
      }
      
      CRITICAL: 
      - Extract EVERY question from the PDF
      - Preserve original order and structure
      - Handle all images and diagrams properly
      - Generate alternatives only when necessary
      - Do not skip any content from the original document
    `;

    const response = await withRetry(async () => {
      console.log("🚀 Making API call to Gemini...");
      const result = await ai.models.generateContent({
        model: model,
        contents: [
          {
            inlineData: {
              data: fileData,
              mimeType: mimeType
            }
          },
          { text: prompt }
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          maxOutputTokens: 16384,
          responseSchema: {
            type: Type.OBJECT,
            description: "The extracted examination paper data.",
            properties: {
              metadata: {
                type: Type.OBJECT,
                description: "General information about the examination paper.",
                properties: {
                  instituteName: { type: Type.STRING, description: "The name of the educational institute." },
                  examName: { type: Type.STRING, description: "The name of the examination." },
                  subjectName: { type: Type.STRING, description: "The name of the subject." },
                  subjectCode: { type: Type.STRING, description: "The code of the subject." },
                  department: { type: Type.STRING, description: "The department name." },
                  maxMarks: { type: Type.NUMBER, description: "The maximum marks for the paper." },
                  instructions: { type: Type.STRING, description: "General instructions for the examination." }
                }
              },
              questions: {
                type: Type.ARRAY,
                description: counts ? `MUST contain EXACTLY ${counts.mcqCount + counts.shortCount + counts.longCount} questions in total (${counts.mcqCount} MCQ, ${counts.shortCount} Short, ${counts.longCount} Long), ORDERED by type (MCQs first, then Short, then Long).` : "All questions found in the document, ORDERED by type (MCQs first, then Short, then Long).",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING, description: "The text of the question." },
                    type: { type: Type.STRING, enum: ["MCQ", "SHORT_ANSWER", "LONG_ANSWER"], description: "The type of the question." },
                    difficulty: { type: Type.STRING, enum: ["EASY", "MEDIUM", "HARD"], description: "The difficulty level of the question." },
                    options: { 
                      type: Type.ARRAY, 
                      items: { type: Type.STRING },
                      description: "The list of options for MCQ questions.",
                      nullable: true 
                    },
                    correctAnswer: { type: Type.STRING, description: "The correct answer to the question." },
                    marks: { type: Type.NUMBER, description: "The marks assigned to the question." },
                    bloomLevel: { type: Type.STRING, description: "The Bloom's Taxonomy level (e.g., Remember, Understand, Apply, Analyze, Evaluate, Create)." },
                    courseOutcome: { type: Type.STRING, description: "The Course Outcome identifier (e.g., CO1, CO2)." },
                    hasImage: { type: Type.BOOLEAN, description: "Set to true if the question refers to or contains an image, diagram, or figure." },
                    imageDescription: { type: Type.STRING, description: "Detailed description of the image/diagram to help recreate it or understand its context." },
                    boundingBox: { 
                      type: Type.ARRAY, 
                      items: { type: Type.INTEGER },
                      description: "Normalized [ymin, xmin, ymax, xmax] coordinates (0-1000) for the image/diagram.",
                      nullable: true
                    },
                    pageNumber: { type: Type.INTEGER, description: "The page number (1-indexed) where the image/diagram is located.", nullable: true },
                    alternativeText: { type: Type.STRING, description: "The text of the alternative (OR) question if present." },
                    alternativeAnswer: { type: Type.STRING, description: "The correct answer for the alternative (OR) question." },
                    section: { type: Type.STRING, description: "The section identifier (e.g., 'Part A', 'Section I')." },
                    sectionTitle: { type: Type.STRING, description: "The title of the section (e.g., 'Objective Questions')." }
                  },
                  required: ["text", "type", "difficulty", "marks", "hasImage"]
                }
              }
            },
            required: ["questions"]
          }
        }
      });
      console.log("✅ API call successful");
      return result;
    }, 3, 1500);

    const jsonText = response.text;
    if (!jsonText) throw new Error("No text returned from Gemini");

    const data = JSON.parse(cleanJsonString(jsonText));
    const rawQuestions = (data.questions || []).filter((q: any) => q && q.text && q.type);
    
    // Log marks assignment for debugging
    console.log("📋 Extracted questions marks check:");
    rawQuestions.forEach((q: any, index: number) => {
      console.log(`Extracted Question ${index + 1}: Type=${q.type}, Marks=${q.marks}, Expected=${q.type === 'MCQ' ? '0.5' : q.type === 'SHORT_ANSWER' ? '2' : '7'}`);
    });
    
    const questionsWithImages = await Promise.all(rawQuestions.map(async (q: any, index: number) => {
      let imageUrl = q.imageUrl;
      
      // For questions with images, extract the actual image from the PDF
      if (q.hasImage) {
        console.log("🔍 Processing image for question:", q.text.substring(0, 50) + "...");
        console.log("Image details:", { hasImage: q.hasImage, boundingBox: q.boundingBox, pageNumber: q.pageNumber, description: q.imageDescription });
        
        try {
          // First try to extract real image from PDF
          if (q.boundingBox && q.pageNumber && Array.isArray(q.boundingBox) && q.boundingBox.length === 4) {
            console.log("📦 Attempting real PDF image extraction with bounding box");
            imageUrl = await extractImageFromPDF(fileData, q.boundingBox, q.pageNumber, mimeType);
          } else {
            console.log("⚠️ No valid bounding box provided, attempting page-level extraction");
            // If no bounding box, try to extract the entire page
            imageUrl = await extractImageFromPDF(fileData, [100, 100, 900, 900], q.pageNumber || 1, mimeType);
          }
        } catch (e) {
          console.error("❌ Failed to extract real image from PDF:", e);
          console.log("📝 Error details:", e?.message);
          
          // Only generate diagram if there's a proper description AND we really need a fallback
          if (q.imageDescription && q.imageDescription.length > 30) {
            console.log("🎨 Generating fallback diagram from description");
            imageUrl = await generateImageFromDescription(q.imageDescription);
          } else {
            console.log("⚪ No proper image description available, leaving image as null");
            imageUrl = null;
          }
        }
      }

      return {
        ...q,
        id: `ocr-${Date.now()}-${index}`,
        options: q.options || [],
        correctAnswer: q.correctAnswer || "",
        hasImage: !!q.hasImage,
        imageDescription: q.imageDescription || "",
        boundingBox: q.boundingBox || null,
        pageNumber: q.pageNumber || 1,
        imageUrl
      };
    }));

    return {
      metadata: data.metadata,
      questions: questionsWithImages
    };

  } catch (error: any) {
    console.error("Gemini OCR Error:", error);
    console.error("Error details:", {
      message: error?.message,
      status: error?.status,
      code: error?.code,
      apiKeyPresent: !!userApiKey
    });
    
    // Provide more specific error messages
    if (error?.message?.toLowerCase().includes("429") || error?.message?.toLowerCase().includes("quota")) {
      throw new Error("API quota exceeded. Please check your API key usage or try again later.");
    } else if (error?.message?.toLowerCase().includes("invalid") || error?.message?.toLowerCase().includes("authentication")) {
      throw new Error("Invalid API key. Please check your Gemini API key in Settings.");
    } else if (error?.message?.toLowerCase().includes("model") || error?.message?.toLowerCase().includes("unavailable")) {
      throw new Error("AI model temporarily unavailable. Please try again in a few minutes.");
    } else {
      throw new Error(`Failed to extract questions: ${error?.message || 'Unknown error occurred'}. Please try again.`);
    }
  }
};

// Extract actual images from PDF using pdf.js
const extractImageFromPDF = async (
  fileData: string, 
  boundingBox: number[], 
  pageNumber: number, 
  mimeType: string
): Promise<string> => {
  try {
    console.log("🖼️ Extracting EXACT image from PDF:", { boundingBox, pageNumber, mimeType });
    
    // Check if we're in browser environment
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      console.log("❌ PDF extraction requires browser environment");
      throw new Error("PDF image extraction requires browser environment");
    }
    
    if (mimeType === 'application/pdf') {
      // Import pdf.js dynamically to avoid SSR issues
      const pdfjsLib = await import('pdfjs-dist');
      
      // Set worker source
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.5.207/pdf.worker.min.js';
      
      // Load the PDF document
      const pdfData = atob(fileData); // Convert base64 to binary
      const loadingTask = pdfjsLib.getDocument({ data: pdfData });
      const pdf = await loadingTask.promise;
      
      // Get the specific page
      const page = await pdf.getPage(pageNumber);
      
      // Get viewport with higher scale for better quality
      const viewport = page.getViewport({ scale: 3.0 });
      
      // Create canvas for rendering the entire page
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error("Failed to get canvas context");
      }
      
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      // Render the entire page
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas
      };
      await page.render(renderContext).promise;
      
      console.log("📄 Page rendered successfully, extracting region...");
      
      // Extract the specific region using bounding box
      const [ymin, xmin, ymax, xmax] = boundingBox;
      
      // Convert normalized coordinates (0-1000) to canvas coordinates
      const x = Math.floor((xmin / 1000) * canvas.width);
      const y = Math.floor((ymin / 1000) * canvas.height);
      const width = Math.floor(((xmax - xmin) / 1000) * canvas.width);
      const height = Math.floor(((ymax - ymin) / 1000) * canvas.height);
      
      console.log("📐 Calculated coordinates:", { x, y, width, height, canvasWidth: canvas.width, canvasHeight: canvas.height });
      
      // Validate coordinates
      if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height) {
        console.log("❌ Invalid bounding box coordinates:", { x, y, width, height });
        
        // Try fallback: extract larger region
        const fallbackX = Math.max(0, x - 50);
        const fallbackY = Math.max(0, y - 50);
        const fallbackWidth = Math.min(canvas.width - fallbackX, width + 100);
        const fallbackHeight = Math.min(canvas.height - fallbackY, height + 100);
        
        console.log("🔄 Using fallback coordinates:", { fallbackX, fallbackY, fallbackWidth, fallbackHeight });
        
        // Create canvas with fallback dimensions
        const fallbackCanvas = document.createElement('canvas');
        const fallbackContext = fallbackCanvas.getContext('2d');
        if (!fallbackContext) {
          throw new Error("Failed to get fallback canvas context");
        }
        
        fallbackCanvas.width = fallbackWidth;
        fallbackCanvas.height = fallbackHeight;
        
        // Copy the larger region
        fallbackContext.drawImage(
          canvas,
          fallbackX, fallbackY, fallbackWidth, fallbackHeight,
          0, 0, fallbackWidth, fallbackHeight
        );
        
        const fallbackImageUrl = fallbackCanvas.toDataURL('image/png', 0.9);
        console.log("✅ Fallback image extracted successfully");
        return fallbackImageUrl;
      }
      
      // Create a new canvas for the extracted region
      const extractedCanvas = document.createElement('canvas');
      const extractedContext = extractedCanvas.getContext('2d');
      if (!extractedContext) {
        throw new Error("Failed to get extracted canvas context");
      }
      
      extractedCanvas.width = width;
      extractedCanvas.height = height;
      
      // Copy the specific region from the rendered page
      extractedContext.drawImage(
        canvas,
        x, y, width, height,  // Source rectangle
        0, 0, width, height   // Destination rectangle
      );
      
      // Convert to data URL with high quality
      const imageUrl = extractedCanvas.toDataURL('image/png', 0.95);
      console.log("✅ EXACT image extracted from PDF successfully");
      console.log("📊 Image size:", { width, height, dataUrlLength: imageUrl.length });
      
      return imageUrl;
    }
    
    throw new Error("Unsupported file type for image extraction");
    
  } catch (error: any) {
    console.error("❌ Failed to extract image from PDF:", error);
    console.error("PDF extraction error details:", {
      message: error?.message,
      boundingBox,
      pageNumber,
      mimeType
    });
    throw error;
  }
};

export const generateImageFromDescription = async (description: string): Promise<string> => {
  console.log("🎨 Creating diagram for description:", description);
  
  // Create professional diagram without API calls
  const createDiagramSVG = (desc: string) => {
    const diagramType = desc.toLowerCase().includes('tree') ? 'tree' : 
                     desc.toLowerCase().includes('flow') ? 'flow' : 
                     desc.toLowerCase().includes('network') ? 'network' : 
                     desc.toLowerCase().includes('algorithm') ? 'algorithm' : 'general';
    
    return `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:1" />
        </linearGradient>
        <filter id="shadow">
          <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.2"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="#f8fafc" rx="12"/>
      
      ${diagramType === 'tree' ? `
        <g filter="url(#shadow)">
          <circle cx="200" cy="50" r="25" fill="url(#grad1)" stroke="#1e40af" stroke-width="2"/>
          <text x="200" y="55" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">15</text>
          <line x1="200" y1="75" x2="150" y2="120" stroke="#64748b" stroke-width="2"/>
          <line x1="200" y1="75" x2="250" y2="120" stroke="#64748b" stroke-width="2"/>
          <circle cx="150" cy="145" r="25" fill="#10b981" stroke="#059669" stroke-width="2"/>
          <text x="150" y="150" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">10</text>
          <circle cx="250" cy="145" r="25" fill="#ef4444" stroke="#dc2626" stroke-width="2"/>
          <text x="250" y="150" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">20</text>
        </g>
      ` : diagramType === 'flow' ? `
        <g filter="url(#shadow)">
          <rect x="150" y="30" width="100" height="40" rx="8" fill="url(#grad1)" stroke="#1e40af" stroke-width="2"/>
          <text x="200" y="55" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">START</text>
          <line x1="200" y1="70" x2="200" y2="100" stroke="#64748b" stroke-width="2"/>
          <polygon points="195,100 200,110 205,100" fill="#64748b"/>
          <rect x="150" y="110" width="100" height="40" rx="8" fill="#10b981" stroke="#059669" stroke-width="2"/>
          <text x="200" y="135" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">PROCESS</text>
          <line x1="200" y1="150" x2="200" y2="180" stroke="#64748b" stroke-width="2"/>
          <polygon points="195,180 200,190 205,180" fill="#64748b"/>
          <rect x="150" y="190" width="100" height="40" rx="8" fill="#ef4444" stroke="#dc2626" stroke-width="2"/>
          <text x="200" y="215" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">END</text>
        </g>
      ` : `
        <g filter="url(#shadow)">
          <rect x="100" y="50" width="200" height="60" rx="8" fill="url(#grad1)" stroke="#1e40af" stroke-width="2"/>
          <text x="200" y="85" text-anchor="middle" fill="white" font-family="Arial" font-size="14" font-weight="bold">SYSTEM</text>
          <rect x="50" y="150" width="120" height="50" rx="8" fill="#10b981" stroke="#059669" stroke-width="2"/>
          <text x="110" y="180" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">MODULE A</text>
          <rect x="230" y="150" width="120" height="50" rx="8" fill="#ef4444" stroke="#dc2626" stroke-width="2"/>
          <text x="290" y="180" text-anchor="middle" fill="white" font-family="Arial" font-size="12" font-weight="bold">MODULE B</text>
          <line x1="200" y1="110" x2="110" y2="150" stroke="#64748b" stroke-width="2"/>
          <line x1="200" y1="110" x2="290" y2="150" stroke="#64748b" stroke-width="2"/>
        </g>
      `}
      
      <text x="200" y="280" text-anchor="middle" font-family="Arial" font-size="11" fill="#64748b">
        ${desc.length > 40 ? desc.substring(0, 40) + '...' : desc}
      </text>
    </svg>`;
  };

  try {
    // Create professional diagram SVG without API calls
    const svgContent = createDiagramSVG(description);
    const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
    const svgUrl = URL.createObjectURL(svgBlob);
    console.log("✅ SUCCESS: SVG diagram created locally");
    return svgUrl;
    
  } catch (error: any) {
    console.error("❌ Image Generation Error:", error);
    
    // Return a simple placeholder
    const placeholderSvg = `
      <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f1f5f9"/>
        <rect x="50" y="50" width="300" height="200" rx="12" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="2"/>
        <circle cx="200" cy="120" r="30" fill="#64748b"/>
        <text x="200" y="125" text-anchor="middle" fill="white" font-family="Arial" font-size="14" font-weight="bold">IMG</text>
        <text x="200" y="270" text-anchor="middle" font-family="Arial" font-size="12" fill="#64748b">
          ${description.substring(0, 35)}...
        </text>
      </svg>
    `;
    
    const svgBlob = new Blob([placeholderSvg], { type: 'image/svg+xml' });
    return URL.createObjectURL(svgBlob);
  }
};

// Fallback for demo without API Key
const mockGenerateQuestions = (count: number, difficulty: Difficulty, targetTotalMarks?: number): Question[] => {
  return Array.from({ length: count }).map((_, i) => {
    const type = i % 3 === 0 ? QuestionType.MCQ : (i % 3 === 1 ? QuestionType.SHORT_ANSWER : QuestionType.LONG_ANSWER);
    let marks = 2;
    if (type === QuestionType.MCQ) marks = 0.5;
    if (type === QuestionType.LONG_ANSWER) marks = 7;
    
    return {
      id: `mock-${Date.now()}-${i}`,
      text: `Mock question ${i + 1} about the requested topic.`,
      type,
      difficulty,
      marks,
      options: type === QuestionType.MCQ ? ["Option A", "Option B", "Option C", "Option D"] : [],
      correctAnswer: type === QuestionType.MCQ ? "Option A" : "Sample answer",
      bloomLevel: "Understand",
      courseOutcome: "CO1",
      hasImage: i % 4 === 0,
      imageDescription: i % 4 === 0 ? "A diagram illustrating the concept" : "",
      boundingBox: null,
      pageNumber: 1,
      alternativeText: type === QuestionType.LONG_ANSWER ? "Alternative question about similar concept" : "",
      alternativeAnswer: type === QuestionType.LONG_ANSWER ? "Alternative answer" : "",
      section: "Section A",
      sectionTitle: "Mock Section"
    };
  });
};