// Vercel Serverless Function — AI 生成エンドポイント
// OpenAI 互換 API を呼ぶ。環境変数 OPENAI_API_KEY が無い場合は、
// 入力から日本語のデモ文書を組み立てて返す（フロントエンドはそのまま動作）。

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = 1400;

function parseValues(userText) {
  const vals = {};
  (userText || "").split(/\n+/).forEach((line) => {
    const m = line.match(/^(.+?)[:：]\s*(.+)$/);
    if (m) vals[m[1].trim()] = m[2].trim();
  });
  return vals;
}

function mock(system, userText) {
  const v = parseValues(userText);
  const kind = (system || "") + (userText || "");
  const scene = v["応募種別"] || v["種別"] || "新卒";
  const job = v["職種"] || v["応募職種"] || "総務・人事";
  const company = v["企業名"] || "御社";
  const exp = v["経験・キーワード"] || v["キーワード"] || "学生時代の企画運営経験";
  const len = v["文字数"] || "400";
  const tone = v["トーン"] || "フォーマル";

  let body = "";
  if (kind.includes("志望動機")) {
    body =
`${company}の${job}職を志望する理由は、${exp}を通じて得た視点を、貴社の事業で活かしたいと考えたからです。

大学時代の経験から、組織を支える仕事にやりがいを感じるようになりました。入社後はまず業務の基礎を確実に身につけ、3年以内に担当領域を任される存在になることを目指します。

（※これはデモ文です。実際の AI はご入力いただいた情報から、もっと具体的でオリジナルな志望動機を生成します。文字数目安：${len}字／トーン：${tone}）`;
  } else if (kind.includes("自己PR")) {
    body =
`【自分の強み】
${exp}を成功させた経験があり、目標に向けて計画を立てて進める力が強みです。

【エピソード】
具体的には、限られた期間の中で関係者と調整を重ね、成果を出しました。このプロセスで得た工夫と粘り強さを、${company}の${job}でも活かせます。

（※デモ文。本番はご入力からオリジナルの自己PRを生成します。）`;
  } else if (kind.includes("履歴書")) {
    body =
`【学歴】
20XX年4月　○○大学 ○○学部 ○○学科 入学
20XX年3月　同 卒業見込

【職歴】
（該当があれば記入）

【志望動機】
${company}（${job}）を志望する理由は、${exp}を活かして貴社に貢献したいと考えたからです。

【自己PR】
${exp}の経験から、最後までやり遂げる力があります。

（※デモ文。上の写真枠に画像を貼り、氏名・住所などを直接編集してください。）`;
  } else if (kind.includes("職務経歴書")) {
    body =
`【氏名】（ご自身で記入）

【職歴】
20XX年4月　○○株式会社 入社　${job}を担当
　　　　　　　・${exp}に関する業務を推進し、成果を達成
20XX年3月　同社 退職

【志望動機】
${company}で、これまでの経験（${exp}）を活かしてさらに貢献したいと考えました。

（※デモ文。写真枠への貼付と、実績の数値化をおすすめします。）`;
  } else if (kind.includes("面接")) {
    body =
`【よく聞かれる質問と回答の構成】

Q. なぜ${company}（${job}）を志望しますか？
A. 結論ファーストで「${exp}を活かしたい」と述べ、その理由を具体的に。

Q. あなたの強みは？
A. ${exp}の経験から得た力を、数値や固有名詞を交えて説明。

Q. 入社後にどんな活躍をしたいですか？
A. 3年後・5年後のビジョンを具体的に。

（※デモ文。本番はあなたの経歴から本番想定の回答を生成します。）`;
  } else {
    body = `${company}向けの${job}に関する文章のデモ出力です。実際の AI はご入力から生成します。`;
  }

  return { text: `【${scene}・${job}】\n\n` + body, mock: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  const messages = (body && body.messages) || [];
  const userText = (messages.filter((m) => m.role === "user").pop() || {}).content || "";
  const system = (messages.find((m) => m.role === "system") || {}).content || "";

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(200).json(mock(system, userText));
    return;
  }

  try {
    const r = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key
      },
      body: JSON.stringify({
        model: body.model || MODEL,
        messages: messages,
        temperature: 0.8,
        max_tokens: MAX_TOKENS
      })
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data.error && data.error.message ? data.error.message : "API error" });
      return;
    }
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    res.status(200).json({ text: text || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
