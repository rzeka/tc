angular.module('tc').directive('streamPanel', function(settings, channels, gui, irc, api) {

	function link(scope, element) {
		scope.m = {
			img : '',
			channel: null,
			stream: null
		};

		load();
		setInterval(load, 60000);
		element.attr('layout', 'column');

		channels.on('change', function() {
			scope.m.stream = null;
			scope.m.channel = null;
			load();
		});

		function getChannel() {
			return settings.channels[settings.selectedTabIndex];
		}

		function load() {
			var channel = getChannel();
			api.channel(channel).success(function(data) {
				scope.m.channel = data;
			});
			api.stream(channel).success(function(data) {
				scope.m.stream = data.stream;
				if (data.stream) {
					var url = data.stream.preview.medium + '?' + new Date().getTime();
					preLoadImage(url, function() {
						scope.m.img = url;
						scope.$apply();
						console.log('STREAM-PANEL: new image is ', scope.m.img);
					});
				}
			})
		}

		function preLoadImage(url, cb) {
			var img = new Image();
			img.src = url;
			img.addEventListener('load', cb);
		}
	}

	return {
		restrict: 'E',
		templateUrl: 'ng/stream-panel/stream-panel.html',
		link: link
	}
});