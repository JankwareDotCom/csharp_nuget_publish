const
    core = require('@actions/core'),
    github = require('@actions/github'),
    fs = require("fs"),
    path = require("path"),
    https = require("https"),
    spawnSync = require("child_process").spawnSync

class Publisher {
    constructor() {
        this.nugetSource = process.env.INPUT_NUGET_SOURCE || this._printErrorAndBail("Nuget Source Required")
        this.nugetKey = process.env.INPUT_NUGET_KEY || this._printErrorAndBail("Nuget Key Required")
        this.buildSymbolsString = (process.env.INPUT_INCLUDE_SYMBOLS || "false").toLowerCase() === "true"
            ? " --include-symbols -p:SymbolPackageFormat=snupkg "
            : ""
        this.publishSymbolsString = (process.env.INPUT_INCLUDE_SYMBOLS || "false").toLowerCase() === "false"
            ? " -n 1 "
            : ""
        this.projectFiles = process.env.INPUT_PROJECT_FILE_PATHS.split(`,`)
        this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || '^.*<Version>(.*)<\\/Version>.*$','gim')
        this.projectVersions = {}
        this.requiresPublishing = []
        this.tagCommits = (process.env.INPUT_TAG_COMMIT || '').split(',')
        this.tagFormat = process.env.INPUT_TAG_FORMAT || 'v*'
        this.branchVersionSuffixes = (process.env.INPUT_BRANCH_VERSION_SUFFIXES || '').split(',')
        this.headBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF && process.env.GITHUB_REF.split('/')[2]
        this.githubToken = process.env.GITHUB_TOKEN || ''
    }

    _getGitHub() {
        if (this.githubToken === undefined || this.githubToken === null || this.githubToken === '') {
            this._printErrorAndBail("GITHUB TOKEN REQUIRED!")
        }

        return new github.getOctokit(this.githubToken)
    }

    async _getExistingTags() {
        const gh = this._getGitHub()
        const {owner, repo} = github.context.repo
        let tags

        try
        {
            tags = await gh.repos.listTags({
                owner, repo, per_page: 1000
            })
        }  catch (err) {
            core.debug(err)
            tags = { data: []}
        }

        return tags.data;
    }

    _getBranchVersionSuffix() {
        const settings = this.branchVersionSuffixes.find(f => f.startsWith(this.headBranch))

        if (!settings || settings.length === 0) {
            return ''
        }

        return settings[0].split('=', 2)[1]
    }

    async _tagCommit(){

        if (!this.tagCommits.includes(this.headBranch)) {
            return
        }

        const version = this.projectVersions[this.projectFiles[0]]
        const versionSuffix = this._getBranchVersionSuffix()
        const tagFormat = this.tagFormat || ''
        const tagFormatted = tagFormat.replace(/\*/g, version)
        const tagName = `${tagFormatted}${versionSuffix}`
        const tags = await this._getExistingTags()

        for (let tag of tags){
            if (tag.name === tagName){
                this._printErrorAndBail("Tag already exists")
            }
        }

        const gh = this._getGitHub();
        const sha = core.getInput('commit-sha', { required: false}) || gh.context.sha
        const tagMessage = `Tagging commit #${sha} with version`
        core.info(tagMessage)
        const tag = await gh.git.createTag({
            ...context.repo,
            tag: tagName,
            message: tagMessage,
            object: sha,
            type: 'commit'
        })
        core.info('applying tag to repo')
        await gh.createRef({
            ...context.repo,
            ref: `refs/tags/${tagName}`,
            sha: tag ? tag.data.sha : process.env.GITHUB_SHA
        })
    }

    _printErrorAndBail(message){
        core.error(`##[error]🛑 ${message}`)
        core.setFailed(new Error(message));
    }

    _checkIfProjectExists(projectFilePath){
        if (!fs.existsSync(projectFilePath)){
            core.info(process.cwd())
            fs.readdirSync(process.cwd()).forEach(file => {
                core.info(`-> ${file}`);
            });
            this._printErrorAndBail(`Unable to find project '${projectFilePath}'`)
        }
    }

    _getPackageName(projectFilePath) {
        return path.basename(projectFilePath).split('.').slice(0,-1).join('.')
    }

    _runCommand(cmd, options) {
        core.info(`executing command: [${cmd}]`)

        const input = cmd.split(" ");
        const tool = input[0];
        const args = input.slice(1)

        return spawnSync(tool, args, options)
    }

    _runCommandInProcess(cmd) {
        this._runCommand(cmd, {
            encoding: "utf-8",
            stdio: [process.stdin, process.stdout, process.stderr]
        })
    }

    _getVersionExists(projectFilePath) {
        const packageName = this._getPackageName(projectFilePath)
        const thisVersion = this.projectVersions[projectFilePath]

        return new Promise((resolve) => {
            https.get(`${this.nugetSource}/v3-flatcontainer/${packageName}/index.json`, res => {
                let body = "";
                if (res.statusCode === 404) {
                    resolve(false)
                } else if (res.statusCode === 200) {
                    res.setEncoding("utf-8")
                    res.on("data", chunk => body += chunk)
                    res.on("end", () => {
                        const remoteVersions = JSON.parse(body)
                        resolve(remoteVersions["versions"].indexOf(thisVersion) > -1)
                    })
                } else {
                    this._printErrorAndBail(`unable to determine remote version for '${packageName}'
                        status: ${res.statusCode}
                        message: ${res.statusMessage}`)
                }
            }).on("error", err =>{
                this._printErrorAndBail(`unable to determine remote version for '${packageName}': ${err.message}`)
            })
        })
    }

    async ensureFormat(){
        // ensure project file(s) have been passed in correctly
        if (!this.projectFiles || this.projectFiles.length === 0) {
            this._printErrorAndBail(`project files not set or improperly set`)
        }
    }

    async ensureExists() {
        // ensure project file(s) exist
        this.projectFiles.forEach(pf => {
            this._checkIfProjectExists(pf)
        })
    }

    async getFileVersions() {
        // get projectFileVersions
        this.projectFiles.forEach(pf => {
            fs.readFile(pf, "utf-8",(err, data) => {
                if (err) {
                    this._printErrorAndBail(err.message)
                }
                const rgx = new RegExp(this.versionRegex)
                const m = rgx.exec(data)
                if (m !== null) {
                    this.projectVersions[pf] = m[1]
                    core.info(`Found version ${m[1]} for '${pf}'`)
                } else {
                    core.info(data)
                    this._printErrorAndBail(`unable to determine version for '${pf}' using regex ${this.versionRegex.toString()}`)
                }
            })
        })
    }

    async startBuilding() {
        // start build process
        fs.readdirSync(".")
            .filter(f => /\.s?nupkg$/.test(f))
            .forEach(x => fs.unlinkSync(x))

        this.requiresPublishing.forEach(pf => {
            const packageName = this._getPackageName(pf)
            const packageVersion = this.projectVersions[pf];
            core.info(`🏭 Starting build process for ${packageName} version ${packageVersion}`)

            try{
                const versionSuffix = this._getBranchVersionSuffix()
                const versionSuffixParam = versionSuffix !== '' ? ` --versionSuffix ${versionSuffix}` : ''
                this._runCommandInProcess(`dotnet build -c Release ${pf}${versionSuffixParam}`)
                this._runCommandInProcess(`dotnet pack${this.buildSymbolsString} --no-build -c Release ${pf} -o .`)
            } catch (err) {
                this._printErrorAndBail(`error building package ${packageName} version ${packageVersion}: ${err.message}`)
            }
        })
    }

    async pushToServer(){
        // push to server
        const packages = fs.readdirSync(".")
            .filter(f => f.endsWith("nupkg"));

        core.info(`🚀 Sending packages... (${packages.join(", ")})`)

        const pushCommand = `dotnet nuget push *.nupkg -s ${this.nugetSource}/v3/index.json -k ${this.nugetKey} --skip-duplicate${this.publishSymbolsString}`
        const pushResults = this._runCommand(pushCommand, {encoding: "utf-8"}).stdout

        core.info(pushResults)

        if(/error/.test(pushResults)) {
            this._printErrorAndBail(`${/error.*/.exec(pushResults)[0]}`)
        }
    }

    async determineIfPublishingIsNeeded(){
        // determine which project(s) need published

        for await (const pf of this.projectFiles) {
            await this._getVersionExists(pf).then((res) => {
                if (!res){
                    this.requiresPublishing.push(pf)
                }
            })
        }

    }

    async run() {
        await this.ensureFormat()
                .then(async () => await this.ensureExists()
                    .then(async () => await this.getFileVersions()
                        .then(async() => await this.determineIfPublishingIsNeeded()
                            .then(async() => this._tagCommit()
                                .then(async() => this.startBuilding()
                                    .then(async() => this.pushToServer())
                                ).catch(c=> core.info(c))
                            ).catch(c=> core.info(c))
                        ).catch(c=> core.info(c))
                    ).catch(c=> core.info(c))
                ).catch(c => core.info(c))
    }
}

new Publisher().run().then(() => core.info('done'))
