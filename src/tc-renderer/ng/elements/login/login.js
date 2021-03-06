import './login.css'
import angular from 'angular'
import template from './login.html'
import settings from '../../../lib/settings/settings'

angular.module('tc').directive('login', function (irc, openExternal) {
  return {
    restrict: 'E',
    template: template,
    link: function (scope) {
      scope.m = {}
      scope.irc = irc
      scope.settings = settings
      // These values should NOT update the settings object or
      // it will break the form's conditionals
      scope.m.username = settings.identity.username
      scope.m.password = settings.identity.password
      scope.m.haveUsername = !!settings.identity.username.length
      scope.m.haveNoPassword = !settings.identity.password.length

      scope.login = login
      scope.generate = () => openExternal('http://gettc.xyz/password/')
      scope.doesntLookLikeToken = doesntLookLikeToken

      function login () {
        settings.identity.username = scope.m.username
        settings.identity.password = scope.m.password
      }

      function doesntLookLikeToken () {
        const password = scope.m.password
        return !!(password && !password.startsWith('oauth'))
      }
    }
  }
})
