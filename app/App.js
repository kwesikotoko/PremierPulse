import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, Text, TextInput, Button, View, FlatList } from 'react-native';
import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';
import { createClient } from '@supabase/supabase-js';
import { io } from 'socket.io-client';

const ENV = Constants.expoConfig?.extra || {};
const SUPABASE_URL = ENV.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
const API_BASE = ENV.API_BASE || 'http://localhost:4000';

if (ENV.SENTRY_DSN) {
  Sentry.init({ dsn: ENV.SENTRY_DSN });
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  const [email, setEmail] = useState('driver@example.com');
  const [password, setPassword] = useState('password');
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [trips, setTrips] = useState([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    const socket = io(API_BASE, { auth: { token: session.access_token } });
    socket.on('hello', (msg) => console.log('socket hello', msg));
    return () => socket.disconnect();
  }, [session]);

  const fetchMe = async () => {
    if (!session) return;
    const res = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const json = await res.json();
    setProfile(json);
  };

  const fetchTrips = async () => {
    if (!session) return;
    const res = await fetch(`${API_BASE}/trips`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const json = await res.json();
    setTrips(json.trips || []);
  };

  const signIn = async () => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) alert(error.message);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 12 }}>
      {!session ? (
        <View>
          <Text>Sign in</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="email" autoCapitalize="none" style={{ borderWidth: 1, padding: 8, marginVertical: 4 }} />
          <TextInput value={password} onChangeText={setPassword} placeholder="password" secureTextEntry style={{ borderWidth: 1, padding: 8, marginVertical: 4 }} />
          <Button title="Sign in" onPress={signIn} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <Text>Logged in</Text>
          <Button title="Load Profile" onPress={fetchMe} />
          <Button title="Load Trips" onPress={fetchTrips} />
          <Button title="Sign out" onPress={signOut} />

          {profile && (
            <View style={{ marginTop: 12 }}>
              <Text>User: {profile.user?.email}</Text>
              <Text>DriverId: {profile.driver?.id}</Text>
            </View>
          )}

          <FlatList
            style={{ marginTop: 12 }}
            data={trips}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={{ paddingVertical: 8 }}>
                <Text>Score: {item.score ?? '-'}</Text>
                <Text>Distance: {item.distanceKm ?? '-'} km</Text>
                <Text>Start: {new Date(item.startTime).toLocaleString()}</Text>
              </View>
            )}
          />
        </View>
      )}
    </SafeAreaView>
  );
}
