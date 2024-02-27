const _ = require("lodash")
const minimatch = require("minimatch")

const BaseCommand = require("./BaseCommand")
const UnapprovedRequestDescription = require("./unapproved/UnapprovedRequestDescription")

const logger = require("../utils/logger")
const markupUtils = require("../utils/markup")
const { NetworkError } = require("../utils/errors")

class Unapproved extends BaseCommand {
  perform = () => {
    return this.projects
      .then(projects => Promise.all(projects.map(this.__getUnapprovedRequests)))
      .then(this.__sortRequests)
      .then(this.__buildMessages)
      .then(this.__logMessages)
      .then(this.messenger.sendMany)
      .catch(err => {
        if (err instanceof NetworkError) {
          logger.error(err)
        } else {
          console.error(err) // eslint-disable-line no-console
        }

        process.exit(1)
      })
  }

  __buildMessages = requests => {
    const markup = markupUtils[this.__getConfigSetting("messenger.markup")]

    if (requests.length) {
      return this.__buildListMessages(requests, markup)
    } else {
      return this.__buildEmptyListMessage(markup)
    }
  }

  __logMessages = messages => {
    this.logger.info("Sending messages")
    this.logger.info(JSON.stringify(messages))
    return messages
  }

  __buildListMessages = (requests, markup) => {
    const headText = "Hey, there are a couple of requests waiting for your review"
    const messages = this.__buildRequestsMessages(requests, markup)
    const header = markup.makeHeader(headText)

    return messages.map((message, idx) => {
      const parts = markup.flatten(message)

      if (idx === 0) {
        return markup.composeMsg(
          markup.withHeader(header, parts),
        )
      }

      return markup.composeMsg(parts)
    })
  }

  __buildRequestsMessages = (requests, markup) => {
    const splitByReviewProgress =
      this.__getConfigSetting("unapproved.splitByReviewProgress")

    if (splitByReviewProgress) {
      return this.__buildByReviewProgressMessages(requests, markup)
    }

    return this.__buildGeneralRequestsMessages(requests, markup)
  }

  __buildEmptyListMessage = markup => {
    const headText = "Hey, there is a couple of nothing"
    const bodyText = "There are no pending requests! Let's do a new one!"

    const header = markup.makeHeader(headText)
    const body = markup.makePrimaryInfo(markup.makeText(bodyText))

    return markup.withHeader(header, body)
  }

  __buildByReviewProgressMessages = (requests, markup) => {
    const messages = []
    const [toReviewRequests, underReviewRequests] = _.partition(requests, req => (
      req.approvals_left > 0 && !this.__isRequestUnderReview(req)
    ))

    const makeSection = _.flow(
      markup.makeBold,
      markup.makeText,
      markup.makePrimaryInfo,
    )

    const toReviewSection = makeSection("Unapproved")
    const underReviewSection = makeSection("Under review")

    const toReviewMessages = this.__buildGeneralRequestsMessages(toReviewRequests, markup)
    const underReviewMessages = this.__buildGeneralRequestsMessages(underReviewRequests, markup)

    toReviewMessages.forEach((chunk, idx) => {
      messages.push(idx === 0 ? [toReviewSection, ...chunk] : chunk)
    })

    underReviewMessages.forEach((chunk, idx) => {
      messages.push(idx === 0 ? [underReviewSection, ...chunk] : chunk)
    })

    return messages
  }

  __buildGeneralRequestsMessages = (requests, markup) => (
    this.__chunkRequests(requests).map(chunk => (
      chunk.map(this.__buildRequestDescription).map(markup.addDivider)
    ))
  )

  __chunkRequests = requests => {
    const requestsPerMessage = this.__getConfigSetting("messenger.requestsPerMessage")
    if (!requestsPerMessage) return [requests]

    return _.chunk(requests, requestsPerMessage)
  }

  __buildRequestDescription = request =>
    new UnapprovedRequestDescription(request, this.config).build()

  __sortRequests = requests => requests
    .flat().sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at))

  __getUnapprovedRequests = project => this.__getExtendedRequests(project.id)
    .then(requests => requests.filter(req => {
      const isCompleted = !req.work_in_progress
      const isUnapproved = req.approvals_left > 0
      const isUnderReview = this.__isRequestUnderReview(req)
      const hasPathsChanges = this.__hasPathsChanges(req.changes, project.paths)

      return isCompleted && hasPathsChanges && (isUnapproved || isUnderReview)
    }))

  __isRequestUnderReview = req => req.discussions
    .some(dis => dis.notes
      .some(note => note.resolvable && !note.resolved))

  __hasPathsChanges = (changes, paths) => {
    if (_.isEmpty(paths)) {
      return true
    }

    return changes.some(change => (
      paths.some(path => (
        minimatch(change.old_path, path) || minimatch(change.new_path, path)
      ))
    ))
  }

  __getExtendedRequests = projectId => this.gitlab
    .project(projectId)
    .then(project => this.gitlab.requests(project.id).then(requests => {
      const promises = requests.map(request => this.__getExtendedRequest(project, request))
      return Promise.all(promises)
    }))

  __getExtendedRequest = (project, request) => Promise.resolve(request)
    .then(req => this.__appendApprovals(project, req))
    .then(req => this.__appendChanges(project, req))
    .then(req => this.__appendDiscussions(project, req))
    .then(req => ({ ...req, project }))

  __appendApprovals = (project, request) => this.gitlab
    .approvals(project.id, request.iid)
    .then(approvals => ({ ...approvals, ...request }))

  __appendChanges = (project, request) => this.gitlab
    .changes(project.id, request.iid)
    .then(changes => ({ ...changes, ...request }))

  __appendDiscussions = (project, request) => this.gitlab
    .discussions(project.id, request.iid)
    .then(discussions => ({ ...request, discussions }))

  __getConfigSetting = (settingName, defaultValue = null) => {
    return _.get(this.config, settingName, defaultValue)
  }
}

module.exports = Unapproved
