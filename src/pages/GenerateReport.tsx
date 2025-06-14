import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, Download, Loader2, Image as ImageIcon, DollarSign, AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import ImageUploader from '../components/ImageUploader';
import ImageComparison from '../components/ImageComparison';
import PDFGenerator from '../components/PDFGenerator';

interface ReportData {
  repaired_image_url: string;
  repair_description: string;
  cost_estimation: {
    total: string;
    breakdown: {
      materials: string;
      labor: string;
      permits: string;
      safety_equipment: string;
    };
  };
  timeline: {
    estimated_duration: string;
    phases: string[];
  };
}

// Add cache interface
interface CacheEntry {
  data: string;
  timestamp: number;
  imageHash: string;
}

// Add rate limiter configuration
const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 10,
  cooldownPeriod: 60000, // 1 minute in milliseconds
};

// Add cache configuration
const CACHE_CONFIG = {
  maxAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  maxEntries: 50,
};

// Add utility functions
const generateImageHash = async (imageUrl: string): Promise<string> => {
  const response = await fetch(imageUrl);
  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

// Add cache manager
class CacheManager {
  private cache: Map<string, CacheEntry>;
  private requestTimestamps: number[];

  constructor() {
    this.cache = new Map();
    this.requestTimestamps = [];
    this.loadFromLocalStorage();
  }

  private loadFromLocalStorage() {
    try {
      const savedCache = localStorage.getItem('geminiApiCache');
      if (savedCache) {
        const parsedCache = JSON.parse(savedCache);
        this.cache = new Map(Object.entries(parsedCache));
      }
    } catch (error) {
      console.warn('Failed to load cache from localStorage:', error);
      this.cache = new Map();
    }
  }

  private saveToLocalStorage() {
    try {
      const cacheObject = Object.fromEntries(this.cache);
      localStorage.setItem('geminiApiCache', JSON.stringify(cacheObject));
    } catch (error) {
      console.warn('Failed to save cache to localStorage:', error);
    }
  }

  async get(imageUrl: string, prompt: string): Promise<string | null> {
    const imageHash = await generateImageHash(imageUrl);
    const cacheKey = `${imageHash}-${prompt}`;
    const entry = this.cache.get(cacheKey);

    if (entry) {
      const age = Date.now() - entry.timestamp;
      if (age < CACHE_CONFIG.maxAge) {
        return entry.data;
      } else {
        this.cache.delete(cacheKey);
      }
    }

    return null;
  }

  async set(imageUrl: string, prompt: string, data: string) {
    const imageHash = await generateImageHash(imageUrl);
    const cacheKey = `${imageHash}-${prompt}`;

    // Remove oldest entry if cache is full
    if (this.cache.size >= CACHE_CONFIG.maxEntries) {
      const oldestKey = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0];
      this.cache.delete(oldestKey);
    }

    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      imageHash,
    });

    this.saveToLocalStorage();
  }

  canMakeRequest(): boolean {
    const now = Date.now();
    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => now - timestamp < RATE_LIMIT_CONFIG.cooldownPeriod
    );

    return this.requestTimestamps.length < RATE_LIMIT_CONFIG.maxRequestsPerMinute;
  }

  recordRequest() {
    this.requestTimestamps.push(Date.now());
  }

  getNextAvailableTime(): number {
    if (this.canMakeRequest()) return 0;

    const oldestTimestamp = this.requestTimestamps[0];
    return Math.max(0, oldestTimestamp + RATE_LIMIT_CONFIG.cooldownPeriod - Date.now());
  }
}

// Create cache manager instance
const cacheManager = new CacheManager();

// Update retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 2000, // 2 seconds
  maxDelay: 30000,    // 30 seconds
  backoffFactor: 2,   // Double the delay each time
};

// Update retry utility function
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  retryConfig = RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;
  let delay = retryConfig.initialDelay;

  for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
    try {
      // Check rate limit before making request
      if (!cacheManager.canMakeRequest()) {
        const waitTime = cacheManager.getNextAvailableTime();
        throw new Error(`Rate limit reached. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
      }

      const result = await operation();
      cacheManager.recordRequest();
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Only retry on quota/rate limit errors
      if (!lastError.message.includes('quota') && 
          !lastError.message.includes('429') && 
          !lastError.message.includes('Rate limit')) {
        throw lastError;
      }

      if (attempt < retryConfig.maxRetries - 1) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
        // Increase delay for next attempt
        delay = Math.min(delay * retryConfig.backoffFactor, retryConfig.maxDelay);
      }
    }
  }

  throw lastError;
}

function GenerateReport() {
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [userDescription, setUserDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processingStep, setProcessingStep] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);
  const [retryDelay, setRetryDelay] = useState(0);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [rateLimitStatus, setRateLimitStatus] = useState<string | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  // Hidden system prompt - not visible to user
  const SYSTEM_PROMPT = `You are a civil engineer and architect AI specializing in infrastructure completion and restoration. Your task is to analyze the provided image and description of incomplete or damaged infrastructure. Focus on:

1. Identifying missing or incomplete structural elements
2. Analyzing the current state of the infrastructure
3. Providing detailed recommendations for completion and restoration
4. Ensuring compliance with Indian safety codes and structural standards

For the analysis, consider:
- Structural integrity and safety requirements
- Modern construction materials and techniques
- Cost-effective solutions
- Required permits and approvals
- Timeline for completion

Provide your analysis in a structured format with clear sections for:
- Current State Assessment
- Required Completion Work
- Safety and Compliance Requirements
- Cost Estimation
- Timeline and Phases
- Required Permits and Approvals`;

  const handleImageUpload = (imageUrl: string) => {
    setUploadedImage(imageUrl);
    setError(null);
    setReportData(null);
  };

  const convertImageToBase64 = async (imageUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx?.drawImage(img, 0, 0);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        // Remove data:image/jpeg;base64, prefix for Gemini
        resolve(base64.split(',')[1]);
      };
      img.onerror = reject;
      img.src = imageUrl;
    });
  };

  const callGeminiVision = async (imageBase64: string, prompt: string): Promise<string> => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('Gemini API key not found. Please add VITE_GEMINI_API_KEY to your .env file.');
    }

    // Check cache first
    const cachedResult = await cacheManager.get(uploadedImage!, prompt);
    if (cachedResult) {
      setCacheStatus('Using cached result');
      return cachedResult;
    }

    setCacheStatus('Cache miss - calling API');

    return retryWithBackoff(async () => {
      try {
        // Check rate limit
        if (!cacheManager.canMakeRequest()) {
          const waitTime = cacheManager.getNextAvailableTime();
          setRateLimitStatus(`Rate limit reached. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
          throw new Error(`Rate limit reached. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: 'image/jpeg',
                      data: imageBase64
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              topK: 32,
              topP: 1,
              maxOutputTokens: 4096,
            },
            safetySettings: [
              {
                category: 'HARM_CATEGORY_HARASSMENT',
                threshold: 'BLOCK_MEDIUM_AND_ABOVE'
              },
              {
                category: 'HARM_CATEGORY_HATE_SPEECH',
                threshold: 'BLOCK_MEDIUM_AND_ABOVE'
              },
              {
                category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                threshold: 'BLOCK_MEDIUM_AND_ABOVE'
              },
              {
                category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                threshold: 'BLOCK_MEDIUM_AND_ABOVE'
              }
            ]
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          
          if (response.status === 429) {
            setRetryCount(prev => prev + 1);
            setRetryDelay(prev => Math.min(prev * 2 || RETRY_CONFIG.initialDelay, RETRY_CONFIG.maxDelay));
            throw new Error('API quota exceeded. Retrying automatically...');
          }
          
          // Handle specific error cases
          if (response.status === 403) {
            throw new Error(
              'API access denied. Please check your API key and billing status. ' +
              'Make sure your API key is valid and has the necessary permissions.'
            );
          } else if (errorData.error?.message) {
            throw new Error(`Gemini API error: ${errorData.error.message}`);
          } else {
            throw new Error(`API request failed with status ${response.status}`);
          }
        }

        const data = await response.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
          throw new Error('No response generated from Gemini');
        }
        
        const result = data.candidates[0].content.parts[0].text;
        
        // Cache the result
        await cacheManager.set(uploadedImage!, prompt, result);
        
        // Reset states
        setRetryCount(0);
        setRetryDelay(0);
        setCacheStatus(null);
        setRateLimitStatus(null);
        
        return result;
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error('An unexpected error occurred while calling the Gemini API');
      }
    });
  };

  const generateImageDescription = async (analysisText: string): Promise<string> => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('Gemini API key not found. Please add VITE_GEMINI_API_KEY to your .env file.');
    }

    const imagePrompt = `Based on this structural analysis: "${analysisText.substring(0, 500)}...", create a detailed description for generating an image of a fully restored Indian commercial building/viaduct structure. The description should include: modern materials, proper safety features, compliance with Indian building codes, professional finish, contemporary Indian infrastructure design elements, proper concrete finishing, modern safety railings, and urban Indian setting. Make it suitable for AI image generation.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: imagePrompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          topK: 32,
          topP: 1,
          maxOutputTokens: 1024,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${errorData.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  };

  const generateRepairedImageWithGemini = async (description: string): Promise<string> => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('Gemini API key not found. Please add VITE_GEMINI_API_KEY to your .env file.');
    }

    // Generate enhanced description for image creation
    const enhancedDescription = await generateImageDescription(description);
    
    // Use Gemini's Imagen 3 model for image generation
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImage?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: `Photorealistic image of a fully restored Indian commercial building/viaduct structure. ${enhancedDescription} High quality architectural photography, professional lighting, modern construction materials, safety compliance with Indian building codes.`,
        numberOfImages: 1,
        aspectRatio: "1:1",
        safetyFilterLevel: "BLOCK_SOME",
        personGeneration: "DONT_ALLOW"
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      // If Imagen is not available, create a placeholder
      console.warn('Imagen API not available:', errorData);
      return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgZmlsbD0iI2Y3ZjhmOSIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNDAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiM2YjczODAiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgUmVzdG9yZWQgU3RydWN0dXJlCiAgPC90ZXh0PgogIDx0ZXh0IHg9IjUwJSIgeT0iNjAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiM5Y2EzYWYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgVmlzdWFsaXphdGlvbgogIDwvdGV4dD4KPC9zdmc+';
    }

    const data = await response.json();
    if (data.generatedImages && data.generatedImages[0]) {
      return `data:image/png;base64,${data.generatedImages[0].bytesBase64Encoded}`;
    }
    
    // Fallback placeholder if no image generated
    return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgZmlsbD0iI2Y3ZjhmOSIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNDAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiM2YjczODAiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgUmVzdG9yZWQgU3RydWN0dXJlCiAgPC90ZXh0PgogIDx0ZXh0IHg9IjUwJSIgeT0iNjAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiM5Y2EzYWYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgVmlzdWFsaXphdGlvbgogIDwvdGV4dD4KPC9zdmc+';
  };

  const handleGenerateReport = async () => {
    if (!uploadedImage) {
      setError('Please upload an image of the infrastructure.');
      return;
    }

    if (!userDescription.trim()) {
      setError('Please provide a description of the infrastructure and what needs to be completed.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setProcessingStep('Converting image...');
    setRetryCount(0);
    setRetryDelay(0);

    try {
      // Step 1: Convert uploaded image to base64
      const imageBase64 = await convertImageToBase64(uploadedImage);
      
      // Step 2: Combine system prompt with user input
      setProcessingStep('Analyzing infrastructure with Gemini AI...');
      const fullPrompt = `${SYSTEM_PROMPT}

User's Infrastructure Description: ${userDescription}

Please analyze the image and description to provide a comprehensive infrastructure completion plan. Include specific details about:
1. What elements are missing or incomplete
2. What needs to be added or repaired
3. How to ensure structural integrity
4. Cost estimates for completion
5. Required safety measures and compliance

Please provide your response in the following JSON format:
{
  "repair_description": {
    "current_state": "Analysis of current infrastructure state",
    "completion_requirements": "Detailed list of what needs to be completed",
    "safety_measures": "Required safety features and compliance measures",
    "recommendations": "Step-by-step recommendations for completion"
  },
  "cost_estimation": {
    "total": "₹X,XX,XXX INR",
    "breakdown": {
      "materials": "₹XX,XXX INR",
      "labor": "₹XX,XXX INR",
      "permits": "₹XX,XXX INR",
      "safety_equipment": "₹XX,XXX INR"
    }
  },
  "timeline": {
    "estimated_duration": "X weeks/months",
    "phases": ["Phase 1: ...", "Phase 2: ..."]
  }
}`;
      
      const analysisResponse = await callGeminiVision(imageBase64, fullPrompt);
      
      // Step 3: Generate completed infrastructure visualization
      setProcessingStep('Generating completed infrastructure visualization...');
      const repairedImageUrl = await generateRepairedImageWithGemini(analysisResponse);
      
      // Parse the analysis response
      let parsedResponse;
      try {
        // Try to extract JSON from the response
        const jsonMatch = analysisResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON found in response');
        }
      } catch (parseError) {
        // Fallback if JSON parsing fails - use the full response as description
        parsedResponse = {
          repair_description: {
            current_state: analysisResponse,
            completion_requirements: "See detailed analysis above",
            safety_measures: "Standard safety protocols apply",
            recommendations: "Follow standard construction guidelines"
          },
          cost_estimation: {
            total: '₹3,00,000 INR',
            breakdown: {
              materials: '₹1,00,000 INR',
              labor: '₹1,50,000 INR',
              permits: '₹25,000 INR',
              safety_equipment: '₹25,000 INR'
            }
          },
          timeline: {
            estimated_duration: "3 months",
            phases: ["Phase 1: Initial assessment and planning", "Phase 2: Construction and completion"]
          }
        };
      }

      const finalReportData: ReportData = {
        repaired_image_url: repairedImageUrl,
        repair_description: JSON.stringify(parsedResponse.repair_description, null, 2),
        cost_estimation: parsedResponse.cost_estimation,
        timeline: parsedResponse.timeline
      };

      setReportData(finalReportData);
      setProcessingStep('');
    } catch (err) {
      console.error('Error generating report:', err);
      let errorMessage = 'Failed to generate report. ';
      
      if (err instanceof Error) {
        if (err.message.includes('quota') || err.message.includes('429')) {
          if (retryCount >= RETRY_CONFIG.maxRetries) {
            errorMessage += '\n\nMaximum retry attempts reached. API Quota Exceeded\n' +
              'The application has reached its API usage limit. Please:\n' +
              '1. Try again later\n' +
              '2. Check your Google Cloud Console for quota status\n' +
              '3. Consider upgrading your API quota if needed\n\n' +
              'For more information, visit: https://ai.google.dev/gemini-api/docs/rate-limits';
          } else {
            errorMessage = `Retrying automatically (Attempt ${retryCount + 1}/${RETRY_CONFIG.maxRetries})...`;
          }
        } else {
          errorMessage += err.message;
        }
      } else {
        errorMessage += 'An unexpected error occurred. Please try again.';
      }
      
      setError(errorMessage);
      if (!errorMessage.includes('Retrying')) {
        setProcessingStep('');
      }
    } finally {
      if (retryCount >= RETRY_CONFIG.maxRetries) {
        setIsLoading(false);
      }
    }
  };

  const canGenerateReport = uploadedImage && !isLoading;

  // Update the loading state UI to show cache and rate limit status
  const renderLoadingState = () => {
    if (!isLoading) return null;

    return (
      <div className="mt-6 space-y-4">
        {cacheStatus && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center">
              <Clock className="w-5 h-5 mr-2 text-green-600" />
              <p className="text-green-800">{cacheStatus}</p>
            </div>
          </div>
        )}

        {rateLimitStatus && (
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex items-center">
              <AlertTriangle className="w-5 h-5 mr-2 text-yellow-600" />
              <p className="text-yellow-800">{rateLimitStatus}</p>
            </div>
          </div>
        )}

        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center">
            {retryCount > 0 ? (
              <>
                <RefreshCw className="w-5 h-5 mr-2 animate-spin text-blue-600" />
                <div className="text-blue-800">
                  <p>Retrying API request (Attempt {retryCount}/{RETRY_CONFIG.maxRetries})</p>
                  {retryDelay > 0 && (
                    <p className="text-sm mt-1">Waiting {retryDelay/1000} seconds before next attempt...</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin text-blue-600" />
                <p className="text-blue-800">{processingStep}</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-16">
            <div className="flex items-center">
              <AlertTriangle className="w-8 h-8 text-blue-600" />
              <span className="ml-2 text-xl font-bold text-gray-900">Aware</span>
              <span className="ml-2 text-sm text-gray-500"></span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">AI-Powered Structural Assessment</h1>
          <p className="mt-2 text-gray-600">Upload an image of damaged infrastructure and get professional civil engineering analysis with Indian compliance standards</p>
        </div>

        {/* API Key and Quota Warning */}
        <div className="mb-8 space-y-4">
          {!import.meta.env.VITE_GEMINI_API_KEY && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center">
                <AlertTriangle className="w-5 h-5 text-amber-600 mr-2" />
                <p className="text-amber-800">
                  <strong>API Key Required:</strong> Please add your Gemini API key to the <code className="bg-amber-100 px-1 rounded">.env</code> file as <code className="bg-amber-100 px-1 rounded">VITE_GEMINI_API_KEY=your_key_here</code>
                </p>
              </div>
            </div>
          )}
          
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center">
              <AlertTriangle className="w-5 h-5 text-blue-600 mr-2" />
              <div className="text-blue-800">
                <p><strong>API Usage Notice:</strong></p>
                <ul className="list-disc list-inside mt-2 text-sm">
                  <li>Free tier has limited API calls per minute and per day</li>
                  <li>Consider upgrading for higher quotas</li>
                  <li>Monitor usage in Google Cloud Console</li>
                </ul>
                <a 
                  href="https://ai.google.dev/gemini-api/docs/rate-limits" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 text-sm mt-2 inline-block"
                >
                  Learn more about API quotas →
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Input Form */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Image Upload */}
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                <ImageIcon className="w-5 h-5 mr-2" />
                Upload Structure Image
              </h2>
              <ImageUploader onImageUpload={handleImageUpload} />
            </div>

            {/* Optional Description */}
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
                <FileText className="w-5 h-5 mr-2" />
                Additional Context (Optional)
              </h2>
              <textarea
                value={userDescription}
                onChange={(e) => setUserDescription(e.target.value)}
                placeholder="Provide any additional context about the structure, location, or specific concerns you have..."
                className="w-full h-32 p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                rows={6}
              />
              <p className="mt-2 text-sm text-gray-500">
                Optional: Add specific details about the structure or your concerns
              </p>
            </div>
          </div>

          {error && (
            <div className={`mt-6 p-4 rounded-lg ${
              error.includes('Retrying') 
                ? 'bg-blue-50 border border-blue-200 text-blue-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}>
              <p className="whitespace-pre-line">{error}</p>
            </div>
          )}

          {renderLoadingState()}

          <div className="mt-8 flex justify-center">
            <button
              onClick={handleGenerateReport}
              disabled={!canGenerateReport}
              className={`inline-flex items-center px-8 py-3 text-lg font-medium rounded-lg transition-all ${
                canGenerateReport
                  ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg hover:shadow-xl'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              ) : (
                <Upload className="w-5 h-5 mr-2" />
              )}
              {isLoading ? 'Generating Professional Report...' : 'Generate Civil Engineering Report'}
            </button>
          </div>
        </div>

        {/* Report Display */}
        {reportData && (
          <div ref={reportRef} className="bg-white rounded-lg shadow-lg p-6">
            <PDFGenerator reportRef={reportRef} reportData={reportData}>
              <div className="mb-8 text-center">
                <h2 className="text-2xl font-bold text-gray-900">Infrastructure Completion Report</h2>
                <p className="mt-2 text-gray-600">AI-Generated Analysis with Indian Compliance Standards</p>
                <div className="mt-2 text-sm text-gray-500">
                  Generated on {new Date().toLocaleDateString('en-IN')} | Powered by Google Gemini
                </div>
              </div>

              {/* Image Comparison */}
              <div className="mb-8">
                <ImageComparison
                  beforeImage={uploadedImage!}
                  afterImage={reportData.repaired_image_url}
                />
              </div>

              {/* Report Content */}
              <div className="space-y-6">
                {/* Current State and Requirements */}
                <div className="pdf-section">
                  <h3 className="text-lg font-semibold text-gray-900">Analysis and Requirements</h3>
                  <div className="mt-4 prose prose-blue max-w-none">
                    <pre className="whitespace-pre-wrap font-sans text-sm">
                      {reportData.repair_description}
                    </pre>
                  </div>
                </div>

                {/* Cost Estimation */}
                <div className="pdf-section">
                  <h3 className="text-lg font-semibold text-gray-900">Cost Estimation</h3>
                  <div className="mt-4">
                    <div className="text-xl font-bold text-blue-600">
                      Total Estimated Cost: {reportData.cost_estimation.total}
                    </div>
                    <div className="pdf-cost-breakdown mt-4">
                      <div>
                        <p className="font-medium">Materials</p>
                        <p className="text-gray-600">{reportData.cost_estimation.breakdown.materials}</p>
                      </div>
                      <div>
                        <p className="font-medium">Labor</p>
                        <p className="text-gray-600">{reportData.cost_estimation.breakdown.labor}</p>
                      </div>
                      <div>
                        <p className="font-medium">Permits</p>
                        <p className="text-gray-600">{reportData.cost_estimation.breakdown.permits}</p>
                      </div>
                      <div>
                        <p className="font-medium">Safety Equipment</p>
                        <p className="text-gray-600">{reportData.cost_estimation.breakdown.safety_equipment}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div className="pdf-section">
                  <h3 className="text-lg font-semibold text-gray-900">Project Timeline</h3>
                  <div className="mt-4">
                    <p className="font-medium">Estimated Duration: {reportData.timeline.estimated_duration}</p>
                    <div className="pdf-timeline mt-4">
                      {reportData.timeline.phases.map((phase, index) => (
                        <div key={index} className="pdf-timeline-phase">
                          {phase}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Download Button */}
                <div className="mt-8 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const pdfGenerator = document.querySelector('.pdf-generator') as HTMLElement;
                      if (pdfGenerator) {
                        pdfGenerator.click();
                      }
                    }}
                    className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <Download className="w-5 h-5 mr-2" />
                    Download Complete Report
                  </button>
                </div>

                {/* Footer */}
                <div className="pdf-footer mt-8">
                  <p>This report is generated using AI analysis and should be reviewed by a qualified civil engineer.</p>
                  <p className="mt-2">© {new Date().getFullYear()} Infrastructure Completion Report Generator</p>
                </div>
              </div>
            </PDFGenerator>
          </div>
        )}
      </div>
    </div>
  );
}

export default GenerateReport;