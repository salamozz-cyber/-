import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { getCalendarDate } from './timeService';
import { xhrFetch } from './xhrFetch';
import { 
    ART_STYLE_PROMPT, 
    ART_STYLE_GLOBAL,
    ART_STYLE_CHARACTER_ADDON,
    LOCATION_PROMPTS, 
    LOCATION_BEHAVIOR_PROMPTS,
    LIGHTING_PRESETS,
    LOCATION_CROWD_CONTEXT,
    PLAYER_PROFILE
} from "../constants";
import { GameState, LocationType, NPC, NPCId, ChatMessage, ActionOption, Item } from "../types";

// 初始化 AI 实例，使用当前配置的 API Key
const getAI = () => {
    const apiKey = process.env.GEMINI_API_KEY || "";
    return new GoogleGenAI({ apiKey });
};

// 表情对应的视觉描述词映射
const EMOTION_PROMPTS: Record<string, string> = {
  neutral: "calm face, gentle gaze",
  happy: "warm smile, bright eyes",
  angry: "serious look, stern eyes",
  sad: "melancholic expression, downturned lips",
  shy: "blushing cheeks, looking away",
  surprise: "eyes widened, lips slightly parted",
  love: "affectionate gaze, tender smile"
};

// 重试逻辑：处理 503 (过载) 和 429 (频率限制)
const retryWithBackoff = async <T>(fn: () => Promise<T>, retries = 3, baseDelay = 2000): Promise<T> => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (e: any) {
      lastError = e;
      if ([429, 500, 503].includes(Number(e.status || e.code))) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
};

/**
 * NEW: 时间映射光效辅助函数
 * 根据 24 小时制的分钟数返回对应的光影描述词。
 */
const getLightingDescription = (minutes: number) => {
    const h = minutes / 60;
    // 修正：5:50 (5.83) 应该属于 Dawn 或 Morning，而不是 Night
    // 之前的逻辑可能在边界判断上有问题
    if (h >= 5 && h < 7) return LIGHTING_PRESETS.DAWN;
    if (h >= 7 && h < 11) return LIGHTING_PRESETS.MORNING;
    if (h >= 11 && h < 14) return LIGHTING_PRESETS.NOON;
    if (h >= 14 && h < 17) return LIGHTING_PRESETS.AFTERNOON;
    if (h >= 17 && h < 19) return LIGHTING_PRESETS.GOLDEN_HOUR;
    if (h >= 19 && h < 22) return LIGHTING_PRESETS.EVENING;
    // 22:00 - 05:00 是夜晚
    if (h >= 22 || h < 5) return LIGHTING_PRESETS.NIGHT;
    
    return LIGHTING_PRESETS.DAWN; // 默认 fallback
};

/**
 * 核心功能：生成场景图像
 * 整合了背景底图、NPC立绘、动态光效和路人逻辑。
 */
export const generateSceneImage = async (
    location: LocationType, 
    mainNpc: NPC | null,
    avatarBase64: string | null,
    time: number,
    customInteractionPrompt: string = "", 
    isDialogueActive: boolean = false,
    userBackgroundBase64: string | null = null,
    emotion: string = "neutral",
    day: number = 1
): Promise<string> => {
  const ai = getAI();
  const lighting = getLightingDescription(time);
  const crowd = LOCATION_CROWD_CONTEXT[location] || "";
  const dateInfo = getCalendarDate(day);

  // 判断是否为室外场景
  const isOutdoor = [
    LocationType.SCHOOL_GATE, 
    LocationType.COMMERCIAL_STREET, 
    LocationType.PARK
  ].includes(location);

  const outdoorContext = isOutdoor ? `SEASON: ${dateInfo.season}. WEATHER: Sunny.` : "";

  let backgroundBase64 = "";
  if (userBackgroundBase64) {
      backgroundBase64 = userBackgroundBase64;
  }
  
  const behaviors = LOCATION_BEHAVIOR_PROMPTS[location] || { idle: { visual: "Standing.", formula: "Wide shot." }, active: { visual: "Talking.", formula: "Close up." } };
  const directorData = isDialogueActive ? behaviors.active : behaviors.idle;

  // 彻底隔离：如果有自定义动作，则完全弃用地点默认行为和默认视角
  const finalAction = customInteractionPrompt || directorData.visual;
  
  const parts: any[] = [];
  
  // 恢复背景参考图
  if (backgroundBase64) {
      parts.push({ text: "REFERENCE BACKGROUND IMAGE:" });
      parts.push({ inlineData: { mimeType: 'image/png', data: backgroundBase64 } });
  }
  
  // 人物参考图
  if (avatarBase64) {
      parts.push({ text: "REFERENCE NPC AVATAR IMAGE:" });
      parts.push({ inlineData: { mimeType: 'image/png', data: avatarBase64 } });
  }

  let compositePrompt = "";

  if (customInteractionPrompt) {
      // --- 动作模式：双人互动场景 ---
      // 提取 NPC 视觉描述
      let npcVisual = "";
      let outfitPrompt = "";
      if (mainNpc) {
          const currentOutfit = mainNpc.outfits?.find(o => o.id === mainNpc.currentOutfitId);
          outfitPrompt = currentOutfit ? currentOutfit.visualPrompt : mainNpc.visualPrompt;
          npcVisual = `${mainNpc.name} (Appearance: ${outfitPrompt}, Body: ${mainNpc.bodyVisualPrompt || 'Average build'}, Emotion: ${emotion})`;
      }

      compositePrompt = `
        High-quality Korean webtoon style illustration.
        Action Scene: ${customInteractionPrompt}
        Characters involved: ${npcVisual} and Pan Yuhang (180cm tall, handsome high school boy, black curly hair).
        Location: ${LOCATION_PROMPTS[location]} in a high school.
        Atmosphere: ${lighting}, ${crowd}.
        
        CRITICAL: 
        1. Render BOTH characters interacting in a third-person cinematic view.
        2. The NPC MUST look exactly like the 'REFERENCE NPC AVATAR IMAGE' (face and hair).
        3. The NPC MUST wear the outfit: ${outfitPrompt}.
        4. ENVIRONMENT: Please refer to the 'REFERENCE BACKGROUND IMAGE' for the setting, but you can adapt it to fit the action naturally.
        5. High detail, sharp lines, cinematic lighting.
      `;
  } else {
      // --- 默认模式：第一人称/单人场景 ---
      const finalFormula = directorData.formula;
      
      let characterDesc = "";
      let outfitPrompt = "";
      if (mainNpc) {
          const currentOutfit = mainNpc.outfits?.find(o => o.id === mainNpc.currentOutfitId);
          outfitPrompt = currentOutfit ? currentOutfit.visualPrompt : mainNpc.visualPrompt;
          const bodyPrompt = mainNpc.bodyVisualPrompt || "";
          characterDesc = `${mainNpc.name} (Body: ${bodyPrompt}, Outfit: ${outfitPrompt}, Emotion: ${emotion})`;
      }

      compositePrompt = `
        High-quality Korean webtoon style game scene.
        View: First-person POV (player's eyes).
        Subject: ${characterDesc} is ${finalAction}.
        Location: ${LOCATION_PROMPTS[location]} in a high school.
        Atmosphere: ${lighting}, ${crowd}.
        Shot Type: ${finalFormula}.
        
        CRITICAL:
        1. The character MUST look exactly like the 'REFERENCE NPC AVATAR IMAGE' (face and hair).
        2. The character MUST wear the outfit: ${outfitPrompt}.
        3. ENVIRONMENT: STRICTLY FOLLOW the 'REFERENCE BACKGROUND IMAGE' for the perspective, style, and setting.
        4. High detail, sharp lines, cinematic lighting.
      `;
  }

  parts.push({ text: compositePrompt });

  try {
      const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-image', 
        contents: { parts: parts },
        config: { imageConfig: { aspectRatio: "16:9" } }
      }));
      // 提取生成的图像数据
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
      }
      console.warn("[Gemini] Scene generation returned no image data");
      return "https://picsum.photos/1920/1080";
  } catch (error: any) { 
      console.error("[Gemini] Scene generation failed:", error?.message || error);
      return "https://picsum.photos/1920/1080"; 
  }
};

/**
 * 核心功能：生成 NPC 头像/立绘
 * 结合上传的参考图和表情描述词生成高质量的 3:4 肖像。
 */
export const generateNPCImage = async (
    npc: NPC, 
    emotion: string = "neutral", 
    location?: LocationType,
    externalReferenceImages?: string[]
): Promise<string> => {
  const ai = getAI();
  
  // 优先查找预设表情，如果没找到，则直接使用 emotion 字符串作为 Prompt (支持括号内的自定义描述)
  const emotionKey = emotion.toLowerCase();
  const emotionDescription = EMOTION_PROMPTS[emotionKey] || emotion;
  
  // 获取当前服装和身材描述
  const currentOutfit = npc.outfits?.find(o => o.id === npc.currentOutfitId);
  const outfitPrompt = currentOutfit ? currentOutfit.visualPrompt : npc.visualPrompt;
  const bodyPrompt = npc.bodyVisualPrompt || "";

  // 构造提示词：结合全局画风、角色视觉描述（身材+服装）和当前表情
  const fullPrompt = `
    ${ART_STYLE_PROMPT} 
    SUBJECT: ${npc.name}. 
    BODY: ${bodyPrompt}
    OUTFIT: ${outfitPrompt}
    EXPRESSION: ${emotionDescription}. 
    Portrait. Upper body shot. High quality, detailed.
    
    CRITICAL INSTRUCTION: 
    1. You MUST use the provided reference image(s) as the GROUND TRUTH for the character's face and hair.
    2. The generated character MUST look EXACTLY like the person in the reference image.
    3. Do NOT change the facial features, hair color, or hair style from the reference.
    4. Ignore the text description if it conflicts with the reference image regarding face/hair.
    5. The character MUST wear the outfit described in APPEARANCE. Do NOT copy the clothing/outfit from the reference image. The reference image is ONLY for the face and hair.
    
    NEGATIVE PROMPT: glasses, spectacles, eyewear, sunglasses, bad anatomy, distorted face.
  `;
  
  const parts: any[] = [];
  
  // 优先使用传入的外部参考图，否则使用 NPC 对象中的参考图
  const refsToUse = externalReferenceImages && externalReferenceImages.length > 0 
      ? externalReferenceImages 
      : npc.referenceImages;

  // 注入上传的参考图（最多取前2张以保证推理效率）
  if (refsToUse && refsToUse.length > 0) {
    refsToUse.slice(0, 2).forEach(img => {
        // 确保数据格式正确，移除可能存在的 data:image/png;base64, 前缀
        const base64Data = img.includes('base64,') ? img.split('base64,')[1] : img;
        parts.push({ inlineData: { mimeType: 'image/png', data: base64Data } });
    });
  }
  
  parts.push({ text: fullPrompt });

  try {
    const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: parts },
      config: { imageConfig: { aspectRatio: "3:4" } }
    }));
    
    // 提取生成的图像
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    return npc.avatarUrl || "https://picsum.photos/300/400";
  } catch (error: any) { 
    console.error("[Gemini] NPC Image Generation Failed:", error?.message || "Unknown error");
    return npc.avatarUrl || "https://picsum.photos/300/400"; 
  }
};

const fallbackGreetings: Record<string, string> = {
    [NPCId.SUJEONG]: "(smiling) 怎么了？找老师有事吗？",
    [NPCId.JIHYUN]: "(waving) Hi there! Good morning!",
    [NPCId.YONGHAO]: "(smirking) 哟，是你啊。",
    [NPCId.KUANZE]: "(eating) 唔...早啊。",
    [NPCId.MOM]: "(caring) 饭吃了吗？",
    [NPCId.XIAOLIN]: "(nodding) 你好。"
};

// 辅助函数：解析 JSON，自动去除 Markdown 代码块标记
const parseJSON = (text: string) => {
    try {
        const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(clean);
    } catch (e: any) {
        console.error("JSON Parse Error:", e?.message || "Unknown error");
        return {};
    }
};

/**
 * 逻辑：生成 NPC 的初始问候
 * 修复：使用更强的模型处理复杂指令，并添加兜底回复。
 */
export const generateGreeting = async (gameState: GameState, npcId: NPCId): Promise<{text: string, emotion: string}> => {
  const ai = getAI();
  const npc = gameState.npcs[npcId];
  
  // 时间与环境上下文构建 (与 generateDialogue 保持一致)
  const h = gameState.time / 60;
  const timeOfDay = (h >= 5 && h < 12) ? "Morning" : (h >= 12 && h < 18) ? "Afternoon" : (h >= 18 && h < 22) ? "Evening" : "Night";
  
  const prompt = `
    Roleplay as ${npc.name}.
    
    [CHARACTER IDENTITY]
    Role: ${npc.role}
    Description: ${npc.description}
    IMPORTANT: You are the TEACHER, the player is a STUDENT. Maintain this dynamic unless the specific relationship level suggests otherwise. Do NOT act as a student.

    [USER IDENTITY - THE PLAYER]
    ${PLAYER_PROFILE}
    
    [CURRENT STATUS]
    Affection Level: ${npc.affection}
    Current Location: ${gameState.location}
    Time: Day ${gameState.day}, ${timeOfDay} (${Math.floor(gameState.time/60)}:${(gameState.time%60).toString().padStart(2,'0')})
    
    [INSTRUCTION]
    1. Generate a greeting message to the player.
    2. Strictly follow the character's persona and role (TEACHER).
    3. Include bracketed actions/expressions, e.g., "(smiling) Good morning."
    4. Return JSON format: {"text": "...", "emotion": "..."}
  `;
  
  try {
    const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({
      model: 'gemini-3-pro-preview', 
      contents: prompt, 
      config: { responseMimeType: "application/json" }
    }));
    const result = parseJSON(response.text || "{}");
    return {
        text: result.text || fallbackGreetings[npcId] || "......",
        emotion: result.emotion || "neutral"
    };
  } catch (error: any) { 
      console.error("Greeting generation failed", error?.message || "Unknown error");
      return { text: fallbackGreetings[npcId] || "......", emotion: "neutral" }; 
  }
};

/**
 * 核心逻辑：生成 NPC 对话回复
 */
export const generateDialogue = async (
    gameState: GameState, 
    npcId: NPCId, 
    userMessage: string,
    history: ChatMessage[] = []
): Promise<{text: string, emotion: string, affectionChange: number}> => {
  const ai = getAI();
  const npc = gameState.npcs[npcId];
  
  // 时间与环境上下文构建
  const h = gameState.time / 60;
  // 修正：确保 5:50 (5.83) 被识别为 Early Morning 而不是 Night
  const timeOfDay = (h >= 5 && h < 12) ? "Morning" : (h >= 12 && h < 18) ? "Afternoon" : (h >= 18 && h < 22) ? "Evening" : "Night";
  const season = "Spring"; // 默认春季
  const weather = "Sunny"; // 默认天气
  
  // 构建最近对话历史字符串 (取最近 10 条)
  const recentHistoryStr = history.slice(-10).map(m => {
      const role = m.sender === 'player' ? 'Player' : npc.name;
      return `${role}: ${m.content}`;
  }).join('\n');

  // 结合长期记忆 (dialogueMemory) 和短期历史 (recentHistoryStr)
  // 如果 dialogueMemory 中已经包含了部分历史，可能会重复，但 LLM 通常能处理
  const memoryContext = `
    [LONG-TERM MEMORY]
    ${npc.dialogueMemory}
    
    [RECENT CONVERSATION]
    ${recentHistoryStr}
  `;

  const prompt = `
    Roleplay as ${npc.name}.
    
    [CHARACTER IDENTITY]
    Role: ${npc.role}
    Description: ${npc.description}
    IMPORTANT: You are the TEACHER, the player is a STUDENT. Maintain this dynamic unless the specific relationship level suggests otherwise. Do NOT act as a student.

    [USER IDENTITY - THE PLAYER]
    ${PLAYER_PROFILE}
    
    [CURRENT STATUS]
    Affection Level: ${npc.affection} (Range: 0-100. 0=Stranger, 50=Friend, 100=Lover).
    Current Location: ${gameState.location}
    Time: Day ${gameState.day}, ${timeOfDay} (${Math.floor(gameState.time/60)}:${(gameState.time%60).toString().padStart(2,'0')})
    Season: ${season}
    Weather: ${weather}
    
    ${memoryContext}
    
    [USER INPUT]
    "${userMessage}"
    (Note: If the input starts with "(动作: ...)", it describes a physical action performed by the player while speaking. React to both the action and the words.)
    
    [INSTRUCTION]
    1. Reply strictly in character based on the Identity, Memory, and Affection Level.
    2. If affection is low, be distant or polite. If high, be warm and intimate.
    3. Include bracketed actions/expressions at the start or end, e.g., "(smiling softly) Hello."
    4. Evaluate the player's message and action:
       - If the player performed an ACTION the character likes: set affectionChange to 1, 2, or 3.
       - If it's just a MESSAGE the character likes: set affectionChange to 1 or 2.
       - If it's offensive or inappropriate: set affectionChange to -1, -2, or -3.
       - Otherwise: set it to 0.
    5. Return JSON format: {"text": "Your reply here...", "emotion": "one of: neutral, happy, angry, sad, shy, surprise, love", "affectionChange": number}
    6. NEGATIVE CONSTRAINT: The character DOES NOT wear glasses. Do NOT generate actions like "pushing glasses", "adjusting spectacles", or "taking off glasses".
  `;
  
  try {
    const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({
      model: 'gemini-3-pro-preview', 
      contents: prompt, 
      config: { 
        responseMimeType: "application/json"
      }
    }));
    const result = parseJSON(response.text || "{}");
    return {
        text: result.text || "......",
        emotion: result.emotion || "neutral",
        affectionChange: Number(result.affectionChange) || 0
    };
  } catch (error) { return { text: "......", emotion: "neutral", affectionChange: 0 }; }
};



/**
 * 核心逻辑：分析对话和动作，生成生图所需的视觉 Prompt
 */
export const analyzeSceneAction = async (
    location: LocationType,
    npcName: string,
    playerAction: string,
    npcReply: string
): Promise<string> => {
    const ai = getAI();
    const prompt = `
        Analyze the following interaction in a high school setting.
        
        [LOCATION]
        ${LOCATION_PROMPTS[location]}
        
        [PLAYER'S ACTION]
        "${playerAction}"
        
        [NPC'S REPLY & REACTION]
        "${npcReply}"
        
        [INSTRUCTION]
        1. Combine the player's action and the NPC's reaction into a single, cohesive visual scene description.
        2. Focus strictly on visual elements: body language, physical interaction, and facial expressions.
        3. The result should be a concise prompt for an image generation model.
        4. Use third-person perspective.
        5. Output ONLY the visual prompt string in English, no other text.
        
        Example Output: "Pan Yuhang is gently patting ${npcName}'s head while she blushes and looks down shyly."
    `;

    try {
        const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt
        }));
        return response.text?.trim() || `${npcName} is interacting with the player.`;
    } catch (error) {
        console.error("Scene action analysis failed:", error);
        return `${npcName} is interacting with the player in a ${LOCATION_PROMPTS[location]} setting.`;
    }
};

/**
 * 核心逻辑：总结对话记忆，防止上下文溢出
 */
export const summarizeConversation = async (npc: NPC, recentHistory: ChatMessage[]): Promise<string> => {
    if (recentHistory.length === 0) return npc.dialogueMemory;
    const ai = getAI();
    const prompt = `Summarize memory for ${npc.name}. History: ${recentHistory.map(m=>m.content).join('\n')}.`;
    
    try {
        const response: GenerateContentResponse = await retryWithBackoff(() => ai.models.generateContent({ 
            model: 'gemini-3-flash-preview', 
            contents: prompt 
        }));
        return response.text || npc.dialogueMemory;
    } catch (e) { return npc.dialogueMemory; }
};

/**
 * 商店功能：生成道具的商品图
 */
export const generateItemImage = async (item: Item): Promise<string> => {
    if (!item.visualPrompt) return item.image || "";
    const ai = getAI();
    
    try {
        const response: GenerateContentResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: { parts: [{ text: `Product Shot: ${item.visualPrompt}` }] },
          config: { imageConfig: { aspectRatio: "1:1" } }
        });
        
        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
        }
        return item.image || "";
    } catch (e) { return item.image || ""; }
};

/**
 * 学习系统：生成对应学科的测验题目
 */
export const generateQuizQuestion = async (subject: string): Promise<any> => {
  const ai = getAI();
  const prompt = `Generate a Grade 1 ${subject} question. JSON: {"question": "...", "options": ["A", "B", "C", "D"], "answer": 0}`;
  
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({ 
        model: 'gemini-3-flash-preview', 
        contents: prompt, 
        config: { responseMimeType: "application/json" } 
    });
    return JSON.parse(response.text || "{}");
  } catch (e) { return { question: "Error", options: ["A", "B"], answer: 0 }; }
};
