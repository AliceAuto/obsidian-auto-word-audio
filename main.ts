import { App, Plugin, PluginSettingTab, Setting, MarkdownView, Notice, requestUrl } from "obsidian";

interface AudioSettings {
	localDir: string;
	onlineTemplate: string;
	useLocalFirst: boolean;
	wordPattern: string;
	enablePeriodicSync: boolean;
	syncIntervalMinutes: number;
	maxDownloadsPerRun: number;
	targetFolder: string;
}

const DEFAULT_SETTINGS: AudioSettings = {
	localDir: ".plugins-data/auto-word-audio",
	onlineTemplate: "https://dict.youdao.com/dictvoice?audio={{word}}&type=2",
	useLocalFirst: false,
	wordPattern: "^\\[\\[([A-Za-z-']+)\\]\\]",
	enablePeriodicSync: false,
	syncIntervalMinutes: 30,
	maxDownloadsPerRun: 30,
	targetFolder: "领域/语言/英语/单词",
};

export default class AutoWordAudioPlugin extends Plugin {
	settings: AudioSettings;
	syncTimer: number | null = null;

	async onload() {
		console.log("[Auto Word Audio] Plugin loading...");
		
		try {
			await this.loadSettings();
			console.log("[Auto Word Audio] Settings loaded");

			// 注册代码块处理器 - 支持 ```word-audio 语法
			this.registerMarkdownCodeBlockProcessor("word-audio", async (source, el, ctx) => {
				console.log("[Auto Word Audio] Processing word-audio code block");
				const words = source.trim().split('\n').map(w => w.trim()).filter(w => w.length > 0);
				const audioRefs: { word: string; audio: HTMLAudioElement }[] = [];
				
				const container = el.createDiv({ cls: "audio-block-container" });
				container.style.cssText = "padding:10px;background:var(--background-secondary);border-radius:4px;";
				
				for (const word of words) {
					const row = container.createDiv({ cls: "audio-row" });
					row.style.cssText = "margin:4px 0;display:flex;align-items:center;gap:8px;";
					
					const label = row.createSpan({ text: word });
					label.style.cssText = "min-width:100px;font-weight:500;";
					
					const audio = row.createEl("audio");
					audio.controls = true;
					audio.style.cssText = "max-width:200px;height:24px;";
					
					const url = await this.getAudioUrl(word);
					audio.src = url;
					audioRefs.push({ word, audio });
					
					// 添加错误处理
					audio.addEventListener('error', (e) => {
						console.error(`[Auto Word Audio] Failed to load audio for "${word}":`, e);
						// 添加错误提示
						const errorMsg = row.createSpan({ text: " ❌ 无音频" });
						errorMsg.style.cssText = "color:var(--text-error);font-size:12px;margin-left:8px;";
					});
					
					// 添加加载成功提示（可选）
					audio.addEventListener('loadedmetadata', () => {
						console.log(`[Auto Word Audio] Successfully loaded audio for "${word}"`);
					});
				}
				
				// 渲染后后台下载，方便后续离线使用
				if (words.length > 0) {
					(async () => {
						const downloaded = await this.downloadToLocal(words);
						if (downloaded > 0) {
							console.log(`[Auto Word Audio] Downloaded ${downloaded} files from code block render`);
							// 如果下载成功并且优先使用本地，则切换到本地源
							if (this.settings.useLocalFirst) {
								for (const ref of audioRefs) {
									try {
										const localUrl = await this.getAudioUrl(ref.word);
										ref.audio.src = localUrl;
										ref.audio.load();
									} catch (err) {
										console.error(`[Auto Word Audio] Failed to switch to local for "${ref.word}":`, err);
									}
								}
							}
						}
					})();
				}
				
				console.log(`[Auto Word Audio] Rendered ${words.length} audio players in code block`);
			});
			console.log("[Auto Word Audio] Code block processor registered for ```audio");

			// 命令：为当前行添加音频标记
			this.addCommand({
				id: "attach-audio-current-line",
				name: "为当前行添加音频标记",
				editorCallback: async (editor) => {
					console.log("[Auto Word Audio] Command: attach-audio-current-line triggered");
					await this.processLines(editor, true);
				}
			});

			// 命令：为整个文件批量添加音频标记
			this.addCommand({
				id: "attach-audio-file",
				name: "为文件所有单词添加音频标记",
				editorCallback: async (editor) => {
					console.log("[Auto Word Audio] Command: attach-audio-file triggered");
					await this.processLines(editor, false);
				}
			});

			// 命令：手动同步音频到本地
			this.addCommand({
				id: "sync-audio-manual",
				name: "立即同步当前文件音频到本地",
				callback: async () => {
					console.log("[Auto Word Audio] Command: sync-audio-manual triggered");
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!view) {
						new Notice("请先打开一个单词笔记");
						return;
					}
					console.log(`[Auto Word Audio] Editor content length: ${view.editor.getValue().length}`);
					const words = this.collectWords(view.editor.getValue());
					console.log(`[Auto Word Audio] Collected ${words.length} words:`, words);
					if (words.length === 0) {
						new Notice("当前文件没有找到单词");
						return;
					}
					new Notice(`开始下载 ${words.length} 个单词的音频...`);
					const count = await this.downloadToLocal(words);
					new Notice(`成功下载 ${count} 个音频文件`);
				}
			});

			// 命令：同步文件夹所有音频到本地
			this.addCommand({
				id: "sync-folder-audio",
				name: "同步目标文件夹所有音频到本地",
				callback: async () => {
					console.log("[Auto Word Audio] Command: sync-folder-audio triggered");
					await this.syncFolderAudio();
				}
			});

			// 命令：为文件夹批量添加音频代码块
			this.addCommand({
				id: "attach-audio-folder",
				name: "为当前文件夹所有文件添加音频代码块",
				callback: async () => {
					console.log("[Auto Word Audio] Command: attach-audio-folder triggered");
					await this.processFolder();
				}
			});

			console.log("[Auto Word Audio] Commands registered");

			// 添加设置面板
			this.addSettingTab(new AudioSettingTab(this.app, this));
			console.log("[Auto Word Audio] Settings tab added");

			// 启动定时同步
			this.startSyncTimer();
			console.log("[Auto Word Audio] Sync timer started");

			console.log("[Auto Word Audio] Plugin loaded successfully!");
		} catch (err) {
			console.error("[Auto Word Audio] Error during onload:", err);
		}
	}

	onunload() {
		if (this.syncTimer) {
			window.clearInterval(this.syncTimer);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 处理文档中的单词行，添加音频
	 */
	async processLines(editor: any, onlyCurrentLine: boolean) {
		const regex = new RegExp(this.settings.wordPattern, "m");
		let inserted = 0;
		let skipped = 0;
		const insertedWords = new Set<string>();
		
		console.log(`[Auto Word Audio] Starting process, onlyCurrentLine: ${onlyCurrentLine}`);

		if (onlyCurrentLine) {
			// 处理单行
			const lineNum = editor.getCursor().line;
			const text = editor.getLine(lineNum);
			console.log(`[Auto Word Audio] Processing line ${lineNum}: ${text}`);
			const match = text.match(regex);
			
			if (match) {
				const word = match[1];
				console.log(`[Auto Word Audio] Found word: ${word}`);
				const result = await this.insertAudioCodeBlockForWord(editor, word, lineNum);
				if (result.inserted) {
					inserted++;
					insertedWords.add(word);
				} else {
					skipped++;
				}
			} else {
				console.log(`[Auto Word Audio] No match found in line`);
			}
		} else {
			// 处理整个文件 - 需要动态获取行数因为会插入新行
			let lineNum = 0;
			let processedWords = new Set<string>();
			
			while (lineNum < editor.lineCount()) {
				const text = editor.getLine(lineNum);
				const match = text.match(regex);
				
				if (match) {
					const word = match[1];
					// 避免重复处理同一个单词
					if (!processedWords.has(word)) {
						processedWords.add(word);
						console.log(`[Auto Word Audio] Found word at line ${lineNum}: ${word}`);
						const result = await this.insertAudioCodeBlockForWord(editor, word, lineNum);
						if (result.inserted) {
							inserted++;
							insertedWords.add(word);
							// 插入了代码块后，跳过新增的几行
							lineNum += 4; // 跳过 ```word-audio, word, ```, 和空行
						} else {
							skipped++;
						}
					}
				}
				lineNum++;
			}
			console.log(`[Auto Word Audio] Processed ${processedWords.size} unique words`);
		}

		console.log(`[Auto Word Audio] Processing complete. Inserted: ${inserted}, Skipped: ${skipped}`);
		if (inserted > 0) {
			new Notice(`已插入 ${inserted} 个音频代码块${skipped > 0 ? `，跳过 ${skipped} 个已有代码块的单词` : ''}`);
		} else if (skipped > 0) {
			new Notice(`所有单词已有音频代码块，跳过 ${skipped} 个`);
		} else {
			new Notice(`未找到需要添加音频代码块的单词`);
		}

		if (insertedWords.size > 0) {
			new Notice(`开始下载 ${insertedWords.size} 个音频文件...`);
			const downloaded = await this.downloadToLocal(Array.from(insertedWords));
			new Notice(`已下载 ${downloaded} 个音频文件`);
		}
	}

	/**
	 * 处理整个文件夹的所有 Markdown 文件
	 */
	async processFolder() {
		const folderPath = this.settings.targetFolder.trim();
		if (!folderPath) {
			new Notice("请先在设置中配置目标文件夹路径");
			return;
		}

		// 获取所有 markdown 文件并过滤
		const allFiles = this.app.vault.getMarkdownFiles();
		const files = allFiles.filter(file => {
			// 文件在目标文件夹下（包括子文件夹）
			return file.path.startsWith(folderPath + "/") || file.parent?.path === folderPath;
		});

		console.log(`[Auto Word Audio] Target folder: "${folderPath}"`);
		console.log(`[Auto Word Audio] Found ${files.length} files in folder`);

		if (files.length === 0) {
			new Notice(`文件夹 "${folderPath}" 中没有 Markdown 文件，请检查路径是否正确`);
			return;
		}

		new Notice(`开始处理 ${files.length} 个文件...`);
		let totalInserted = 0;
		let totalSkipped = 0;
		let filesProcessed = 0;
		const insertedWords = new Set<string>();

		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				const regex = new RegExp(this.settings.wordPattern, "gm");
				const matches = content.matchAll(regex);
				
				let modified = false;
				let newContent = content;
				let processedWords = new Set<string>();

				for (const match of matches) {
					const word = match[1];
					if (processedWords.has(word)) continue;
					processedWords.add(word);

					// 检查是否已有该单词的代码块
					const blockPattern = new RegExp(`\`\`\`word-audio\\s*\\n\\s*${word}\\s*\\n\\s*\`\`\``, 'i');
					if (blockPattern.test(newContent)) {
						console.log(`[Auto Word Audio] Skipping "${word}" in ${file.path} - already has block`);
						totalSkipped++;
						continue;
					}

					// 查找单词位置并插入代码块
					// 格式：[[word]] 后面可以有音标等内容，然后换行到 ?
					// 例如：[[wisdom]] /ˈwɪzdəm/ 或 [[wisdom]]
					// 匹配 ? 后面的换行和空白，替换时不留空行
					const wordPattern = new RegExp(`(\\[\\[${word}\\]\\][^\\n]*)\\n\\s*\\?\\s*\\n`, 'i');
					
					if (wordPattern.test(newContent)) {
						const codeBlock = `\`\`\`word-audio\n${word}\n\`\`\``;
						newContent = newContent.replace(
							wordPattern,
							`$1\n?\n${codeBlock}\n`
						);
						modified = true;
						totalInserted++;
						insertedWords.add(word);
						console.log(`[Auto Word Audio] Inserted block for "${word}" in ${file.path}`);
					} else {
						console.log(`[Auto Word Audio] Word "${word}" in ${file.path} - pattern not found`);
					}
				}

				if (modified) {
					await this.app.vault.modify(file, newContent);
					filesProcessed++;
				}
			} catch (err) {
				console.error(`[Auto Word Audio] Error processing ${file.path}:`, err);
			}
		}

		let downloaded = 0;
		if (insertedWords.size > 0) {
			new Notice(`开始下载 ${insertedWords.size} 个音频文件...`);
			downloaded = await this.downloadToLocal(Array.from(insertedWords));
			new Notice(`已下载 ${downloaded} 个音频文件`);
		}

		new Notice(`完成！处理 ${filesProcessed} 个文件，插入 ${totalInserted} 个代码块，跳过 ${totalSkipped} 个，下载 ${downloaded} 个音频文件`);
	}

	/**
	 * 同步目标文件夹所有单词的音频到本地
	 */
	async syncFolderAudio() {
		const folderPath = this.settings.targetFolder.trim();
		if (!folderPath) {
			new Notice("请先在设置中配置目标文件夹路径");
			return;
		}

		const allFiles = this.app.vault.getMarkdownFiles();
		const files = allFiles.filter(file => {
			return file.path.startsWith(folderPath + "/") || file.parent?.path === folderPath;
		});

		if (files.length === 0) {
			new Notice(`文件夹 "${folderPath}" 中没有 Markdown 文件`);
			return;
		}

		new Notice(`开始收集文件夹中的单词...`);
		const allWords = new Set<string>();

		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				const words = this.collectWords(content);
				words.forEach(w => allWords.add(w));
			} catch (err) {
				console.error(`[Auto Word Audio] Error reading ${file.path}:`, err);
			}
		}

		const wordList = Array.from(allWords);
		new Notice(`找到 ${wordList.length} 个不重复的单词，开始下载...`);
		
		const count = await this.downloadToLocal(wordList);
		new Notice(`成功下载 ${count} 个音频文件到本地`);
	}

	/**
	 * 为单个单词插入音频代码块
	 */
	async insertAudioCodeBlockForWord(editor: any, word: string, wordLineNum: number): Promise<{inserted: boolean}> {
		const totalLines = editor.lineCount();
		const wordPattern = new RegExp(this.settings.wordPattern);
		
		let insertLineNum = wordLineNum + 1;
		let foundQuestionMark = false;
		
		// 先扫描整个单词区域，检查是否已有代码块
		for (let i = wordLineNum + 1; i < Math.min(wordLineNum + 20, totalLines); i++) {
			const line = editor.getLine(i);
			const trimmed = line.trim();
			
			// 检查是否遇到代码块
			if (trimmed === "```word-audio") {
				// 检查接下来的几行内容
				for (let j = i + 1; j < Math.min(i + 5, totalLines); j++) {
					const contentLine = editor.getLine(j).trim();
					if (contentLine === word) {
						console.log(`[Auto Word Audio] Found existing code block for "${word}" between lines ${i}-${j}`);
						return { inserted: false };
					}
					// 遇到代码块结束符，停止检查这个块
					if (contentLine === "```") {
						break;
					}
				}
			}
			
			// 记录 ? 的位置
			if (trimmed === "?") {
				foundQuestionMark = true;
				insertLineNum = i + 1;
			}
			
			// 遇到下一个单词或分隔符，停止扫描
			if (trimmed === "---" || (i > wordLineNum + 1 && wordPattern.test(line))) {
				break;
			}
		}
		
		// 如果没找到 ?，就插入在单词的下一行
		if (!foundQuestionMark) {
			insertLineNum = wordLineNum + 1;
		}
		
		// 构建代码块
		const codeBlock = `\`\`\`word-audio\n${word}\n\`\`\``;
		console.log(`[Auto Word Audio] Inserting code block for "${word}" at line ${insertLineNum}`);
		
		// 如果目标行为空行，替换它；否则在前面插入
		const targetLineText = editor.getLine(insertLineNum) ?? "";
		if (targetLineText.trim() === "") {
			// 目标行是空的，用代码块替换掉这个空行
			const replaceTo = { line: insertLineNum, ch: targetLineText.length };
			editor.replaceRange(codeBlock + "\n", { line: insertLineNum, ch: 0 }, replaceTo);
		} else {
			// 目标行有内容，在前面插入代码块（不替换目标行）
			editor.replaceRange(codeBlock + "\n", { line: insertLineNum, ch: 0 });
		}
		
		return { inserted: true };
	}

	/**
	 * 检查某行是否包含特定单词的音频代码块（保留备用）
	 */
	hasAudioCodeBlockForWord(line: string, word: string): boolean {
		// 检查是否是 word-audio 代码块且包含该单词
		const blockRegex = /```word-audio/i;
		return blockRegex.test(line) && line.includes(word);
	}

	/**
	 * 获取单词的音频 URL
	 */
	async getAudioUrl(word: string): Promise<string> {
		const onlineUrl = this.settings.onlineTemplate.replace("{{word}}", encodeURIComponent(word));
		const localPath = this.settings.localDir 
			? `${this.settings.localDir}/${word}.mp3`.replace(/\/+/g, "/")
			: "";

		// 如果设置优先使用本地，先检查本地文件
		if (this.settings.useLocalFirst && localPath) {
			try {
				const exists = await this.app.vault.adapter.exists(localPath);
				console.log(`[Auto Word Audio] Local check for "${word}": path="${localPath}", exists=${exists}`);
				if (exists) {
					// 优先尝试 adapter 的 getResourcePath（直接用路径，不依赖 TFile）
					const adapterAny = this.app.vault.adapter as any;
					if (adapterAny.getResourcePath) {
						const resourcePath = adapterAny.getResourcePath(localPath);
						console.log(`[Auto Word Audio] Using local file (adapter) for "${word}": ${resourcePath}`);
						return resourcePath;
					}

					// 退回使用 TFile 方式
					const file = this.app.vault.getAbstractFileByPath(localPath);
					if (file) {
						const resourcePath = this.app.vault.getResourcePath(file as any);
						console.log(`[Auto Word Audio] Using local file (vault) for "${word}": ${resourcePath}`);
						return resourcePath;
					}

					console.warn(`[Auto Word Audio] Local file exists but not found in vault index for "${word}" at ${localPath}`);
				}
			} catch (err) {
				console.error(`[Auto Word Audio] Error checking local file for "${word}":`, err);
			}
		}
		
		// 使用在线音频
		console.log(`[Auto Word Audio] Using online URL for "${word}": ${onlineUrl}`);
		return onlineUrl;
	}

	/**
	 * 收集文本中的所有单词
	 */
	collectWords(text: string): string[] {
		console.log(`[collectWords] Pattern: ${this.settings.wordPattern}, text length: ${text.length}`);
		const regex = new RegExp(this.settings.wordPattern, "gm");
		const words = new Set<string>();
		let match;
		
		while ((match = regex.exec(text)) !== null) {
			console.log(`[collectWords] Found match:`, match[1]);
			words.add(match[1]);
		}
		
		console.log(`[collectWords] Total unique words: ${words.size}`, Array.from(words));
		return Array.from(words);
	}

	/**
	 * 下载音频到本地
	 */
	async downloadToLocal(words: string[]): Promise<number> {
		const dir = this.settings.localDir.replace(/\/+$/, "");
		
		console.log(`[Auto Word Audio] Download target directory: ${dir}`);
		
		// 创建目录（如果不存在）
		try {
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.createFolder(dir);
				console.log(`[Auto Word Audio] Created directory: ${dir}`);
			}
		} catch (err) {
			console.error(`[Auto Word Audio] Failed to create directory:`, err);
			new Notice(`无法创建目录 ${dir}`);
			return 0;
		}

		let downloaded = 0;
		let skipped = 0;
		let failed = 0;

		for (const word of words) {
			if (downloaded >= this.settings.maxDownloadsPerRun) {
				console.log(`[Auto Word Audio] Reached max downloads limit (${this.settings.maxDownloadsPerRun})`);
				break;
			}

			const targetPath = `${dir}/${word}.mp3`;
			
			// 如果文件已存在，跳过
			if (await this.app.vault.adapter.exists(targetPath)) {
				skipped++;
				console.log(`[Auto Word Audio] Skipping "${word}" - file exists`);
				continue;
			}

			const url = this.settings.onlineTemplate.replace("{{word}}", encodeURIComponent(word));

			try {
				console.log(`[Auto Word Audio] Downloading "${word}" from ${url}`);
				
				const response = await requestUrl({
					url: url,
					method: "GET",
					throw: false
				});

				console.log(`[Auto Word Audio] Response status for "${word}": ${response.status}`);

				if (response.status >= 200 && response.status < 300) {
					await this.app.vault.adapter.writeBinary(targetPath, response.arrayBuffer);
					downloaded++;
					console.log(`[Auto Word Audio] Successfully downloaded "${word}" to ${targetPath}`);
					
					// 添加小延迟，避免请求过快
					await new Promise(resolve => setTimeout(resolve, 200));
				} else {
					failed++;
					console.error(`[Auto Word Audio] Failed to download "${word}": HTTP ${response.status}`);
				}
			} catch (e) {
				failed++;
				console.error(`[Auto Word Audio] Error downloading "${word}":`, e);
			}
		}

		console.log(`[Auto Word Audio] Download summary - Success: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`);
		return downloaded;
	}

	/**
	 * 启动定时同步
	 */
	startSyncTimer() {
		if (this.syncTimer) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (!this.settings.enablePeriodicSync) return;

		const intervalMs = Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000;

		this.syncTimer = window.setInterval(async () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			const words = this.collectWords(view.editor.getValue());
			if (words.length === 0) return;

			const count = await this.downloadToLocal(words);
			if (count > 0) {
				new Notice(`后台同步完成：下载了 ${count} 个音频文件`);
			}
		}, intervalMs);
	}
}

class AudioSettingTab extends PluginSettingTab {
	plugin: AutoWordAudioPlugin;

	constructor(app: App, plugin: AutoWordAudioPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Auto Word Audio 设置" });

		// 本地音频目录
		new Setting(containerEl)
			.setName("本地音频目录")
			.setDesc("音频文件保存的相对路径（相对于 vault 根目录）")
			.addText(text => text
				.setPlaceholder("Audio")
				.setValue(this.plugin.settings.localDir)
				.onChange(async (value) => {
					this.plugin.settings.localDir = value.trim();
					await this.plugin.saveSettings();
				}));

		// 在线音频模板
		new Setting(containerEl)
			.setName("在线音频模板")
			.setDesc("使用 {{word}} 作为单词占位符。默认使用有道词典美音")
			.addText(text => text
				.setPlaceholder("https://dict.youdao.com/dictvoice?audio={{word}}&type=2")
				.setValue(this.plugin.settings.onlineTemplate)
				.onChange(async (value) => {
					this.plugin.settings.onlineTemplate = value.trim();
					await this.plugin.saveSettings();
				}));

		// 优先使用本地
		new Setting(containerEl)
			.setName("优先使用本地音频")
			.setDesc("启用后，如果本地存在音频文件，优先使用本地；否则使用在线音频")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useLocalFirst)
				.onChange(async (value) => {
					this.plugin.settings.useLocalFirst = value;
					await this.plugin.saveSettings();
				}));


		// 单词匹配模式
		new Setting(containerEl)
			.setName("单词匹配正则表达式")
			.setDesc("用于匹配单词行的正则表达式，第一个捕获组应为单词本身")
			.addText(text => text
				.setPlaceholder("^\\[\\[([A-Za-z-']+)\\]\\]")
				.setValue(this.plugin.settings.wordPattern)
				.onChange(async (value) => {
					this.plugin.settings.wordPattern = value;
					await this.plugin.saveSettings();
				}));

		// 目标文件夹
		new Setting(containerEl)
			.setName("批量处理目标文件夹")
			.setDesc("批量添加音频代码块时处理的文件夹路径（相对于 vault 根目录）")
			.addText(text => text
				.setPlaceholder("领域/语言/英语/单词")
				.setValue(this.plugin.settings.targetFolder)
				.onChange(async (value) => {
					this.plugin.settings.targetFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		containerEl.createEl("h3", { text: "定期同步设置" });

		// 启用定期同步
		new Setting(containerEl)
			.setName("启用定期同步")
			.setDesc("定期从在线音源下载缺失的音频到本地")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enablePeriodicSync)
				.onChange(async (value) => {
					this.plugin.settings.enablePeriodicSync = value;
					await this.plugin.saveSettings();
					this.plugin.startSyncTimer();
				}));

		// 同步间隔
		new Setting(containerEl)
			.setName("同步间隔（分钟）")
			.setDesc("定期同步的时间间隔")
			.addSlider(slider => slider
				.setLimits(5, 180, 5)
				.setValue(this.plugin.settings.syncIntervalMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncIntervalMinutes = value;
					await this.plugin.saveSettings();
					this.plugin.startSyncTimer();
				}));

		// 每次最大下载数
		new Setting(containerEl)
			.setName("每次最大下载数")
			.setDesc("每轮同步最多下载的音频文件数量，避免请求过多")
			.addSlider(slider => slider
				.setLimits(5, 200, 5)
				.setValue(this.plugin.settings.maxDownloadsPerRun)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxDownloadsPerRun = value;
					await this.plugin.saveSettings();
				}));
	}
}

