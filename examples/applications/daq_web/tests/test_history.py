"""High-rate display history must preserve time extent and peaks without changing raw data."""
import collections
import importlib.util
import pathlib
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('daq_server',pathlib.Path(__file__).resolve().parents[1]/'server.py')
server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
class Bridge:
    logs=collections.deque()
    def call(self,op,**kwargs):return {'batches':[]}
    def close(self):pass
class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.station=server.Station(Bridge(),self.tmp.name)
        self.addCleanup(self.tmp.cleanup);self.addCleanup(self.station.close)
        self.station.series={'signal':self.station._new_series()}
    def test_40khz_history_covers_twelve_seconds_and_preserves_a_single_sample_peak(self):
        for start in range(0,480001,4000):
            ticks=list(range(start,min(480001,start+4000)))
            self.station._ingest({'id':'signal','values':[99 if t==123456 else 0 for t in ticks],
                                  'ticks':[str(t) for t in ticks],'tickNumerator':'1','tickDenominator':'40000'})
        live=self.station.live()['series'][0]
        self.assertEqual(live['count'],480001);self.assertEqual(len(live['rawPoints']),8192)
        self.assertAlmostEqual(live['points'][-1][0]-live['points'][0][0],12)
        self.assertTrue(any(p[1]==99 for p in live['points']))
        self.assertLessEqual(len(live['points']),12004)
    def test_history_is_time_bounded_and_handles_timestamp_restart(self):
        h=server.DisplayHistory()
        for i in range(4001):h.append([i*.01,i])
        self.assertGreaterEqual(h.points()[0][0],9.99)
        h.append([0,5]);self.assertEqual(h.points(),[[0,5]])
    def test_vectors_keep_dimension_coordinates_and_record_every_bin(self):
        self.station.running=True;self.station.command('record_start',{})
        self.station._ingest({'id':'signal','kind':'vector','frames':[{
            'axis':[0,10,20],'values':[1,2,3],'axisUnit':'Hz','tick':'100','tickDenominator':'1000'}]})
        live=self.station.live()['series'][0]
        self.assertEqual(live['kind'],'vector');self.assertEqual(live['count'],1)
        self.assertEqual(live['frame']['axis'],[0,10,20]);self.assertEqual(self.station.record['rows'],3)
        self.station.command('record_stop',{})
        text=next(pathlib.Path(self.tmp.name).glob('*.csv')).read_text()
        self.assertIn('dimension_coordinate',text);self.assertIn(',2,20,Hz',text)
    def test_errors_are_per_signal_and_do_not_erase_valid_data(self):
        self.station._ingest({'id':'signal','values':[3],'ticks':['1']})
        self.station._ingest({'id':'signal','error':'reader failed'})
        live=self.station.live()['series'][0]
        self.assertEqual(live['count'],1);self.assertEqual(live['error'],'reader failed')
if __name__=='__main__':unittest.main(verbosity=2)
