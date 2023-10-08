const fs = require("fs");
const path = require("path");
const recursiveCopy = require("recursive-copy");

const process = require("process");
const ghp = require("gh-pages");

const yamlParser = require("json-to-pretty-yaml");
const frontMatter = require("yaml-front-matter");
const titleCase = require("to-title-case");

const sha = require("js-sha1");
const {
	detectPackageManager,
	installDependencies,
	addDependency,
	addDevDependency,
	removeDependency,
} = require("nypm");
const { exec } = require("child_process");
const { create } = require("domain");
const { config } = require("yargs");
const SNIP = "<!--hide-readme-content-before-this-line-->";

async function Property() {
	return fs.readFileSync(
		path.join(__dirname, "components/Property.md"),
		"utf-8"
	);
}

async function Function() {
	return fs.readFileSync(
		path.join(__dirname, "components/Function.md"),
		"utf-8"
	);
}

async function Type() {
	return fs.readFileSync(path.join(__dirname, "components/Type.md"), "utf-8");
}

async function Member(
	settings,
	member,
	luaClass,
	extraTypes,
	memberPath,
	component
) {
	let base = fs.readFileSync(
		path.join(__dirname, "components/Member.md"),
		"utf-8"
	);

	let memberContent = "";
	memberContent += await component(member, luaClass, extraTypes, memberPath);
	memberContent += member.desc != "" ? "\n" + member.desc : "";
	base = base.replaceAll("$MEMBER_CONTENT$", memberContent);
	base = base.replaceAll("$MEMBERPATH$", memberPath);
	base = base.replace(
		"$MEMBER_LINK$",
		`${settings.sourceUrl}/${member.source.path}#L${member.source.line}`
	);

	return base;
}

const capitalize = (text) => text[0].toUpperCase() + text.substring(1);

const run = async (cmd) => {
	const child = exec(cmd, (err) => {
		if (err) console.error(err);
	});
	child.stderr.pipe(process.stderr);
	child.stdout.pipe(process.stdout);
	await new Promise((resolve) => child.on("close", resolve));
};

module.exports = async function (
	typeLinks,
	sidebarClassNames,
	luaClasses,
	settings,
	foundDocs,
	verbose
) {
	// make directory for markdown
	const basePath = path.join(process.cwd(), settings.output || "temp");

	const pathHash = sha(basePath);
	const folderPath = path.join(global.appRoot, "docSources", pathHash);

	const mdPath = settings.tempDataOutput || path.join(folderPath, "src");
	const apiPath = path.join(mdPath, "api");

	fs.mkdirSync(apiPath, { recursive: true });
	fs.mkdirSync(apiPath, { recursive: true });

	if (sidebarClassNames[0] == undefined) {
		throw new Error("No classes found in sidebarClassNames");
	}

	// create sidebar, navbar, footer & social links
	// default values:
	// API sidebar
	// GitHub (based on gitRepoButton)
	// NavBar API button
	let modifiableConfig = JSON.parse(JSON.stringify(global.config));
	let themeConfig = modifiableConfig.vitepress;
	//let themeConfig = JSON.parse(JSON.stringify(vitepressData)); // deep copy vitepressData

	// inject data that we have available
	// github repo button
	if (
		global.config.has("gitRepoButton") &&
		global.config.get("gitRepoButton")
	) {
		settings.addGitButton = true;
		themeConfig.socialLinks.push({
			icon: "github",
			link: settings.gitRepo,
		});
	}

	// navbar api button
	if (!themeConfig.nav.find((item) => item.text === "API")) {
		themeConfig.nav.push({
			text: "API",
			link: sidebarClassNames[0].href,
		});
	}

	// sidebar
	// map sidebarClassNames to custom sidebar groups (if specified)
	let remainingClassNames = sidebarClassNames.slice(0);
	themeConfig.sidebar["api"] = {
		text: "API",
		items: [],
	};

	let createdSectionSidebars = [];

	if (
		global.config.has("classSections") &&
		global.config.get("classSections")
	) {
		// recursively iterate through classsections and map them to the sidebar
		function iterate(sidebarData, currentSidebar) {
			let addedAsRoot = false;
			let sidebar = {
				text: sidebarData.section,
				items: [],
			};

			if (sidebarData.classes) {
				// in case an empty sidebar is provided, useful for padding sections
				for (const className of sidebarData.classes) {
					const fndData = remainingClassNames.find(
						(item) => item.label == className
					);
					if (fndData) {
						remainingClassNames.splice(
							remainingClassNames.findIndex((item) => item.label == className),
							1
						);

						if (sidebarData.isRoot) {
							if (sidebarData.children == undefined) {
								// add ourselves to currentsidebar.items
								currentSidebar.items.push({
									text: fndData.label,
									link: fndData.href,
								});

								addedAsRoot = true;
								continue;
							}

							if (addedAsRoot) {
								throw new Error(
									'Tried to add sidebar element as root to a group that already had a class as root. Make sure that you don\'t have "isRoot" enabled on a sidebar element with more than 2 classes.'
								);
							}
							// if collapse is enabled, the sidebar will be a link to the first item in the section
							// and the items will be nested under it
							sidebar = {
								text: fndData.label,
								link: fndData.href,
								items: [],
							};

							addedAsRoot = true;
							continue;
						}

						sidebar.items.push({
							text: fndData.label,
							link: fndData.href,
						});
					}
				}
			}

			if (addedAsRoot && sidebarData.children == undefined) {
				// we've added all children to parent, no need to do it again
				return;
			}

			currentSidebar.items.push(sidebar);

			if (sidebarData.children) {
				for (const child of sidebarData.children) {
					iterate(child, sidebar);
				}
			}

			return sidebar;
		}

		for (const sidebarData of global.config.get("classSections")) {
			createdSectionSidebars.push(
				iterate(sidebarData, {
					text: sidebarData.section,
					items: [],
				})
			);
		}
	}

	if (remainingClassNames.length > 0) {
		themeConfig.sidebar["api"].items.push({
			text: "API",
			items: remainingClassNames.map((className) => {
				return {
					text: className.label,
					link: className.href,
				};
			}),
		});
	}

	for (const sidebar of createdSectionSidebars) {
		themeConfig.sidebar["api"].items.push(sidebar);
	}

	// map docs to markdown files
	// create front matter for each class
	for (const luaClass of luaClasses) {
		// front matter for each class is basically just all data to be used in the file
		// so functions, etc
		// we have to define this before we run because its SSR
		let mdBase = fs.readFileSync(path.join(__dirname, "class.md"), "utf-8");

		// resolve important info
		const sections = [
			{
				name: "types",
				component: Type,
			},
			{
				name: "properties",
				component: Property,
			},
			{
				name: "functions",
				component: Function,
			},
		];
		const actualClass = luaClass.class;

		// Sort LuaClass body members
		sections.forEach((section) => {
			actualClass[section.name] = actualClass[section.name]
				.filter((member) => !member.ignore)
				.sort((memberA, memberB) => {
					if (!memberA.deprecated && memberB.deprecated) {
						return -1;
					} else if (memberA.deprecated && !memberB.deprecated) {
						return 1;
					} else {
						if (
							memberA.function_type === "static" &&
							memberB.function_type === "method"
						) {
							return -1;
						} else if (
							memberA.function_type === "method" &&
							memberB.function_type === "static"
						) {
							return 1;
						}
						return 0;
					}
				});
		});

		const extraTypes = new Map();
		const skipMembers = new Set();
		const typeOccurrences = new Map();

		for (const type of luaClass.class.types) {
			if (type.desc.length > 0) {
				continue;
			}

			for (const fn of luaClass.class.functions) {
				if (
					[...fn.params, ...fn.returns].some(({ lua_type }) =>
						lua_type.includes(type.name)
					)
				) {
					if (typeOccurrences.has(type)) {
						typeOccurrences.set(type, null);
					} else {
						typeOccurrences.set(type, fn);
					}
				}
			}
		}

		for (const [type, fn] of typeOccurrences) {
			if (!fn) {
				continue;
			}

			const types = extraTypes.get(fn) || [];
			extraTypes.set(fn, types);

			types.push(type);
			skipMembers.add(type);
		}

		// map all sections to a markdown string
		let sectionString = "";

		for (const section of sections) {
			let sectionBase = fs.readFileSync(
				path.join(__dirname, "components/Section.md"),
				"utf-8"
			);
			sectionBase = sectionBase.replace(
				"$SECTION_TITLE$",
				capitalize(section.name)
			);

			// iterate through members
			const members = actualClass[section.name];

			if (members.length == 0) {
				continue;
			}

			let memberString = "";

			for (const idx in members) {
				const member = members[idx];

				if (!skipMembers.has(member)) {
					memberString += await Member(
						settings,
						member,
						actualClass,
						extraTypes.get(member),
						`.${section.name}[${idx}]`,
						section.component
					);
				}
			}

			sectionString += sectionBase.replace("$SECTION_CONTENT$", memberString);
		}

		mdBase = mdBase.replace("$SECTION_LIST$", sectionString);

		// resolve Markdown() expressions
		const regex = new RegExp(/Markdown\((.*?)\)/g);

		for (const match of [...mdBase.matchAll(regex)]) {
			const str = match[1];
			let current = actualClass;
			// iterate throgh front matter
			eval(`current = current${str}`);
			if (current == undefined) {
				throw new Error(
					`Could not resolve chain ${str} in markdown file class.md`
				);
			}

			mdBase = mdBase.replace(match[0], current);
		}

		let extraTypesNew = {};

		for (const [_, fn] of typeOccurrences) {
			// map to function index
			for (const func of luaClass.class.functions) {
				if (func == fn) {
					extraTypesNew[luaClass.class.functions.indexOf(fn)] =
						extraTypes.get(fn);
				}
			}
		}

		const frontMatterObject = {
			typeLinks,
			settings,
			extraTypes: extraTypesNew,
			class: luaClass.class,
			outline:
				global.config.has("nestSections") && global.config.get("nestSections")
					? [2, 3]
					: 2,
		};

		let frontMatter = yamlParser.stringify(frontMatterObject);

		fs.writeFileSync(
			`${apiPath}/${luaClass.name}.md`,
			mdBase
				.replace("$FRONT_MATTER$", frontMatter)
				.replace(
					"$CLASS_LINK$",
					`${settings.sourceUrl}/${luaClass.class.source.path}#L${luaClass.class.source.line}`
				)
		);
	}

	// iterate actions, replace api_path with first api url
	for (let action of themeConfig.actions) {
		if (action.href == "api_path") {
			action.href = sidebarClassNames[0].href;
		}
	}

	// inject data into index.md
	let frontmatterHome = {
		layout: modifiableConfig.readmeAsHome ? "doc" : "page",
		actions: themeConfig.actions,
		features: themeConfig.features,
		title: modifiableConfig.title,
		description: modifiableConfig.description,
	};

	let index = fs
		.readFileSync(path.join(__dirname, "index.md"), "utf-8")
		.replace("$FRONTMATTER_HOME$", JSON.stringify(frontmatterHome));

	if (modifiableConfig.readmeAsHome) {
		const snip = foundDocs.readme.indexOf(SNIP);
		let readme = foundDocs.readme;
		if (snip > 0) {
			readme = readme.slice(snip + SNIP.length);
		}

		index = index.replace(
			"$README_DATA$",
			`<div class="vpdoc-home">\n\n${readme}\n</div>`
		);
		index = index.replace("$INCLUDE_HOME$", "");
	} else {
		index = index.replace("$README_DATA$", "");
		index = index.replace("$INCLUDE_HOME$", "<Home />");
	}

	fs.writeFileSync(`${mdPath}/index.md`, index);

	// create config
	// changelog page
	if (modifiableConfig.includeChangelog) {
		if (!foundDocs.changelog) {
			throw new Error(
				'includeChangelog was true, but no file containing "changelog" was found in the project directory.'
			);
		}

		let outline = JSON.stringify([2, 3]);

		if (modifiableConfig.changelogOutline) {
			outline = JSON.stringify(modifiableConfig.changelogOutline);
		}

		fs.writeFileSync(
			`${mdPath}/changelog.md`,
			`---\noutline: ${outline}\n---\n<div class="vpdoc-home">\n\n${foundDocs.changelog}\n</div>`
		);
		// add to navbar
		themeConfig.nav.push({
			text: "Changelog",
			link: "/changelog",
		});
	}

	// generate src/docs if needed
	if (fs.existsSync(path.join(process.cwd(), "docs"))) {
		async function iterateDocs(dir, sidebarPath) {
			let sidebar;

			for (const file of fs.readdirSync(dir)) {
				if (fs.lstatSync(path.join(dir, file)).isDirectory()) {
					iterateDocs(path.join(dir, file), sidebarPath + "/" + file);
					continue;
				}

				const filePath = path.join(dir, file);
				const frontmatter = frontMatter.loadFront(fs.readFileSync(filePath));
				const group =
					frontmatter.group ||
					(modifiableConfig.sidebarAliases &&
						modifiableConfig.sidebarAliases[sidebarPath]) ||
					titleCase(path.basename(sidebarPath));

				if (themeConfig.sidebar[sidebarPath] == undefined) {
					themeConfig.sidebar[sidebarPath] = [];
				}

				sidebar = themeConfig.sidebar[sidebarPath];

				let groupSidebar = themeConfig.sidebar[sidebarPath].find(
					(item) => item.text === group
				);

				// check if we're dealing with a situation where the group has multiple layers
				// (contains a /)
				if (group.includes("/")) {
					const groups = group.split("/");

					// recursively create sidebars for each group, and add ourselves into the last one
					let currentGroup = themeConfig.sidebar[sidebarPath];
					let currentSidebar = null;

					for (const group of groups) {
						let groupSidebar = currentGroup.find((item) => item.text === group);

						if (groupSidebar == undefined) {
							groupSidebar = {
								text: group,
								items: [],
							};

							currentGroup.push(groupSidebar);
						}

						currentGroup = groupSidebar.items;
						currentSidebar = groupSidebar
					}

					groupSidebar = currentSidebar
				}

				if (groupSidebar == undefined) {
					groupSidebar = {
						text: group,
						items: [],
					};

					themeConfig.sidebar[sidebarPath].push(groupSidebar);
				}

				// add self into group
				groupSidebar.items.push({
					text: frontmatter.title || titleCase(path.basename(file, ".md")),
					link: `${sidebarPath}/${path.basename(file, ".md")}`,
					position: frontmatter.position || 0,
				});
			}

			// sort all groups in the sidebar on the position var
			for (const group of sidebar) {
				group.items.sort((a, b) => {
					if (a.position < b.position) {
						return -1;
					} else if (a.position > b.position) {
						return 1;
					} else {
						return 0;
					}
				});
			}
		}

		iterateDocs(path.join(process.cwd(), "docs"), "docs");

		// clone docs folder into base
		// remove old folder if exists
		if (fs.existsSync(path.join(mdPath, "docs"))) {
			fs.rmSync(path.join(mdPath, "docs"), { recursive: true });
		}

		await recursiveCopy(
			path.join(process.cwd(), "docs"),
			path.join(mdPath, "docs")
		);
	}

	if (settings.tempDataOutput == undefined) {
		fs.writeFileSync(
			`${folderPath}/config.json`,
			JSON.stringify(modifiableConfig)
		);

		for (const filePath of fs.readdirSync(path.join(__dirname, "theme"))) {
			if (fs.existsSync(path.join(folderPath, filePath))) {
				fs.rmSync(path.join(folderPath, filePath), { recursive: true });
			}

			await recursiveCopy(
				path.join(__dirname, "theme", filePath),
				path.join(folderPath, filePath)
			);
		}
	} else {
		fs.writeFileSync(
			path.join(settings.tempDataOutput, "../", "config.json"),
			JSON.stringify(modifiableConfig)
		);
	}

	if (settings.output == undefined) {
		return folderPath;
	}

	// run npm i in project directory
	console.log(
		"Updating dependencies. If this is your first run, this may take a bit. Please wait..."
	);

	await installDependencies({
		cwd: folderPath,
		packageManager: {
			command: "npm",
		},
	});

	// build vitepress
	const oldDir = process.cwd();
	process.chdir(folderPath);
	await run("npm run docs:build");

	// delete current folderi f exists
	if (fs.existsSync(basePath)) {
		fs.rmSync(basePath, { recursive: true });
	}

	if (verbose == undefined || verbose) {
		console.log("Moving files, or publishing to GitHub pages..");
	}

	if (settings.output != "github-pages") {
		await recursiveCopy(path.join(folderPath, "dist"), basePath);
		fs.rmSync(path.join(folderPath, "dist"), { recursive: true });
	} else {
		// publish to gh-pages
		process.chdir(oldDir);
		await ghp.publish(path.join(folderPath, "dist"), function (err) {
			console.log("Failed to push to GitHub Pages:", err);
		});

		fs.rmSync(path.join(folderPath, "dist"), { recursive: true });
	}
};