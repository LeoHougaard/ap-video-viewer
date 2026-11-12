import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_project = app.PROJECT
        app.PROJECT = Path(self.temp.name) / 'project.json'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        app.PROJECT = self.original_project
        self.temp.cleanup()

    def request(self, path, data=None):
        request = Request(self.base + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def imported(self):
        payload = {'courseId': '7', 'courseName': 'AP Chemistry', 'unit': '1', 'clips': [
            {'id': 'video11111', 'name': 'First', 'unit': '1'},
            {'id': 'video22222', 'name': 'Second', 'unit': '1'},
            {'id': 'video33333', 'name': 'Third', 'unit': '2'},
        ]}
        status, result = self.request('/api/ap-import', payload)
        self.assertEqual(status, 200)
        self.assertEqual(result['units'], 2)
        return payload

    def test_units_reimport_and_local_files_preserve_edits(self):
        payload = self.imported()
        edits = {'libraryId': 'ap:7:1', 'items': [
            {'id': 'video22222', 'trim': 12.5, 'end': 83.2},
            {'id': 'video11111', 'trim': 1, 'end': None},
        ]}
        self.assertEqual(self.request('/api/project', edits)[0], 200)
        self.request('/api/select', {'libraryId': 'ap:7:2'})
        second = self.request('/api/project')[1]
        self.assertEqual([c['id'] for c in second['clips']], ['video33333'])
        self.assertEqual(second['clips'][0]['trim'], 0)
        self.request('/api/ap-import', payload)
        first = self.request('/api/project')[1]['clips']
        self.assertEqual([c['id'] for c in first], ['video22222', 'video11111'])
        self.assertEqual((first[0]['trim'], first[0]['end']), (12.5, 83.2))
        self.request('/api/folder', {'folder': self.temp.name})
        self.request('/api/select', {'libraryId': 'ap:7:1'})
        self.assertEqual(self.request('/api/project')[1]['clips'], first)
        with app.lock:
            app.write_store(app.read_store())
        self.assertEqual(self.request('/api/project')[1]['clips'], first)

    def test_invalid_cutoffs_and_stale_tabs_do_not_overwrite(self):
        self.imported()
        before = app.PROJECT.read_bytes()
        for end in [0, -1, 3, float('nan'), float('inf'), 86400]:
            status, _ = self.request('/api/project', {'libraryId': 'ap:7:1', 'items': [
                {'id': 'video11111', 'trim': 3, 'end': end},
                {'id': 'video22222', 'trim': 0},
            ]})
            self.assertEqual(status, 400)
            self.assertEqual(app.PROJECT.read_bytes(), before)
        self.request('/api/select', {'libraryId': 'ap:7:2'})
        self.assertEqual(self.request('/api/project', {'libraryId': 'ap:7:1', 'items': []})[0], 400)

    def test_legacy_project_is_migrated_without_losing_trim(self):
        legacy = {'source': 'ap', 'courseName': 'AP Chemistry', 'items': [
            {'id': 'video11111', 'name': 'First', 'unit': '1', 'trim': 12.5,
             'apUrl': 'https://apclassroom.collegeboard.org/7/home?apd=video11111&unit=1'}]}
        app.PROJECT.write_text(json.dumps(legacy))
        data = self.request('/api/project')[1]
        self.assertEqual(data['libraryId'], 'ap:7:1')
        self.assertEqual(data['clips'][0]['trim'], 12.5)
        self.assertIsNone(data['clips'][0]['end'])
        self.imported()
        self.assertEqual(self.request('/api/project')[1]['clips'][0]['trim'], 12.5)

    def test_local_video_range_and_both_cutoffs(self):
        folder = Path(self.temp.name) / 'clips'
        folder.mkdir()
        (folder / 'lesson.mp4').write_bytes(bytes(range(100)))
        self.request('/api/folder', {'folder': str(folder)})
        data = self.request('/api/project')[1]
        clip = data['clips'][0]
        status, _ = self.request('/api/project', {'libraryId': 'files', 'items': [{'id': clip['id'], 'trim': 2, 'end': 8}]})
        self.assertEqual(status, 200)
        saved = self.request('/api/project')[1]['clips'][0]
        self.assertEqual((saved['trim'], saved['end']), (2, 8))
        with urlopen(Request(self.base + clip['url'], headers={'Range': 'bytes=10-19'})) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), bytes(range(10, 20)))


if __name__ == '__main__':
    unittest.main()
